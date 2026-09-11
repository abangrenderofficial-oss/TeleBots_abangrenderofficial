import { waitUntil } from '@vercel/functions';
import fastRecapHandler from './telegram-fast-recap.js';
import { telegram, isAdminMessage } from '../lib/telegram.js';
import {
  finishActiveSendBatch,
  getActiveSendBatch,
  isSendPaused,
  saveActiveSendBatch,
  startActiveSendBatch,
} from '../lib/send-control.js';
import {
  getQueueItem,
  getSetting,
  listQueueItems,
  setSetting,
  updateQueueItem,
} from '../lib/store.js';
import {
  SENDALL_WORKER_VERSION,
  triggerSendAllWorker,
} from '../lib/sendall-chain.js';

const SEND_ALL_SNAPSHOT_LIMIT = 1000;
const MAX_ITEMS_PER_WORKER = 25;
const WORKER_TIME_BUDGET_MS = 45_000;
const CHAIN_GAP_MS = 150;
const SAVE_EVERY = 2;
const WORKER_LOCK_TTL_MS = 90_000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return fastRecapHandler(req, res);

  if (req.body?.__sendall_worker === true) {
    return acceptWorker(req, res);
  }

  const query = req.body?.callback_query;
  if (
    !query?.message
    || !isAdminMessage({ from: query.from })
    || String(query.data || '') !== 'sendall'
  ) {
    return fastRecapHandler(req, res);
  }

  const chatId = query.message.chat.id;
  await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  if (await isSendPaused(chatId)) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: '⏸ SEND masih STOP. Guna /resume dulu.',
    }).catch(() => {});
    return res.status(200).json({ ok: true, paused: true });
  }

  const active = await getActiveSendBatch(chatId).catch(() => null);
  if (
    active?.worker === SENDALL_WORKER_VERSION
    && !active?.completed
    && remainingInBatch(active) > 0
  ) {
    return res.status(200).json({
      ok: true,
      already_running: true,
      remaining: remainingInBatch(active),
    });
  }

  const destination = await resolveDestination();
  if (!destination) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: 'Destination belum set lagi. Dalam group target, hantar /connect sekali.',
    });
    return res.status(200).json({ ok: true, no_destination: true });
  }

  const items = await buildSnapshotFromClickedPreview(chatId, query.message.message_id);
  if (!items.length) {
    await telegram('sendMessage', { chat_id: chatId, text: 'Tak ada item pending.' });
    return res.status(200).json({ ok: true, empty: true });
  }

  let batch = await startActiveSendBatch(chatId, items, 'normal');
  batch.snapshot_total = items.length;
  batch.worker = SENDALL_WORKER_VERSION;
  batch.worker_token = makeToken();
  batch.destination = String(destination);
  batch = await saveActiveSendBatch(chatId, batch);

  await setSetting('admin_state', null).catch(() => {});

  // The webhook returns immediately. Real sending runs in a separate Vercel
  // worker invocation, and each worker hands the batch to a NEW invocation before
  // the current function can hit its execution-time ceiling.
  waitUntil(
    triggerSendAllWorker({
      chatId,
      batchId: batch.id,
      workerToken: batch.worker_token,
    }).catch(async (error) => {
      await saveWorkerError(chatId, batch.id, error);
    }),
  );

  return res.status(200).json({
    ok: true,
    queued: true,
    total: items.length,
    batch_id: batch.id,
  });
}

async function acceptWorker(req, res) {
  const chatId = String(req.body?.chat_id || '');
  const batchId = String(req.body?.batch_id || '');
  const workerToken = String(req.body?.worker_token || '');

  if (!chatId || !batchId || !workerToken) {
    return res.status(400).json({ ok: false, error: 'invalid_worker_request' });
  }

  const batch = await getActiveSendBatch(chatId).catch(() => null);
  if (
    !batch
    || String(batch.id) !== batchId
    || String(batch.worker_token || '') !== workerToken
    || batch.worker !== SENDALL_WORKER_VERSION
  ) {
    return res.status(403).json({ ok: false, error: 'invalid_worker_token' });
  }

  if (batch.completed || remainingInBatch(batch) <= 0) {
    return res.status(200).json({ ok: true, completed: true });
  }

  waitUntil(
    runWorkerChunk(chatId, batchId, workerToken).catch(async (error) => {
      console.error('SEND ALL worker failed:', error?.message || error);
      await saveWorkerError(chatId, batchId, error);
    }),
  );

  return res.status(202).json({
    ok: true,
    accepted: true,
    batch_id: batchId,
    remaining: remainingInBatch(batch),
  });
}

async function runWorkerChunk(chatId, batchId, workerToken) {
  const lock = await claimWorkerLock(chatId, batchId);
  if (!lock.claimed) return;

  let shouldChain = false;
  let chainBatch = null;

  try {
    let batch = await getActiveSendBatch(chatId).catch(() => null);
    if (
      !batch
      || String(batch.id) !== String(batchId)
      || String(batch.worker_token || '') !== String(workerToken)
      || batch.worker !== SENDALL_WORKER_VERSION
      || batch.completed
    ) {
      return;
    }

    if (await isSendPaused(chatId)) return;

    const destination = batch.destination || await resolveDestination();
    if (!destination) {
      await saveWorkerError(chatId, batchId, new Error('Destination belum set'));
      return;
    }

    batch = {
      ...batch,
      item_ids: Array.isArray(batch.item_ids) ? batch.item_ids : [],
      next_index: Number(batch.next_index || 0),
      sent: Number(batch.sent || 0),
      failed: Number(batch.failed || 0),
    };

    const startedAt = Date.now();
    let processed = 0;
    let sinceSave = 0;

    while (batch.next_index < batch.item_ids.length) {
      if (await isSendPaused(chatId)) {
        batch = await saveActiveSendBatch(chatId, batch);
        return;
      }

      if (
        processed >= MAX_ITEMS_PER_WORKER
        || (processed > 0 && Date.now() - startedAt >= WORKER_TIME_BUDGET_MS)
      ) {
        break;
      }

      const item = await getQueueItem(batch.item_ids[batch.next_index]).catch(() => null);
      if (!item) {
        batch.next_index += 1;
        processed += 1;
        sinceSave += 1;
      } else {
        const status = String(item.status || '').toUpperCase();
        if (!['READY', 'FAILED'].includes(status)) {
          batch.next_index += 1;
          processed += 1;
          sinceSave += 1;
        } else {
          const result = await sendOneFast(item, destination);
          if (result.ok) batch.sent += 1;
          else batch.failed += 1;

          batch.next_index += 1;
          processed += 1;
          sinceSave += 1;
        }
      }

      if (sinceSave >= SAVE_EVERY || batch.next_index >= batch.item_ids.length) {
        batch = await saveActiveSendBatch(chatId, batch);
        sinceSave = 0;
      }
    }

    if (sinceSave > 0) batch = await saveActiveSendBatch(chatId, batch);

    if (batch.next_index >= batch.item_ids.length) {
      batch = await finishActiveSendBatch(chatId, batch);
      const failedText = batch.failed > 0 ? ` · ${batch.failed} failed` : '';
      await telegram('sendMessage', {
        chat_id: chatId,
        text: `✅ SEND ALL selesai · ${batch.sent} sent${failedText}`,
      });
      return;
    }

    if (await isSendPaused(chatId)) return;

    shouldChain = true;
    chainBatch = batch;
  } finally {
    await releaseWorkerLock(chatId, batchId, lock.token).catch(() => {});
  }

  if (shouldChain && chainBatch) {
    await sleep(CHAIN_GAP_MS);
    await triggerSendAllWorker({
      chatId,
      batchId: chainBatch.id,
      workerToken: chainBatch.worker_token,
    });
  }
}

async function buildSnapshotFromClickedPreview(chatId, previewMessageId) {
  const rows = await listQueueItems(chatId, SEND_ALL_SNAPSHOT_LIMIT);
  const all = (rows || []).filter((row) => String(row.admin_chat_id) === String(chatId));
  const anchor = all.find((row) => String(row.preview_message_id) === String(previewMessageId));

  let candidates = all.filter((row) => ['READY', 'FAILED'].includes(String(row.status || '').toUpperCase()));

  if (anchor?.source_chat_id != null && anchor?.source_message_id != null) {
    candidates = candidates.filter((row) => (
      String(row.source_chat_id) === String(anchor.source_chat_id)
      && Number(row.source_message_id) >= Number(anchor.source_message_id)
    ));
  }

  return candidates.sort((a, b) => {
    const aMsg = Number(a.source_message_id);
    const bMsg = Number(b.source_message_id);
    if (Number.isFinite(aMsg) && Number.isFinite(bMsg) && aMsg !== bMsg) return aMsg - bMsg;
    return Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
  });
}

async function sendOneFast(item, destination) {
  try {
    const sent = await copyWithRateLimitRetry({
      chat_id: destination,
      from_chat_id: item.source_chat_id,
      message_id: item.source_message_id,
      parse_mode: 'HTML',
      caption: item.final_caption_html || '',
    });

    await updateQueueItem(item.id, {
      status: 'SENT',
      destination_chat_id: String(destination),
      destination_message_id: sent?.message_id || null,
      sent_at: new Date().toISOString(),
      error_message: null,
    });
    return { ok: true };
  } catch (error) {
    await updateQueueItem(item.id, {
      status: 'FAILED',
      error_message: String(error?.message || error).slice(0, 1000),
    }).catch(() => {});
    return { ok: false, error: String(error?.message || error) };
  }
}

async function copyWithRateLimitRetry(payload) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await telegram('copyMessage', payload);
    } catch (error) {
      lastError = error;
      const retrySeconds = parseRetryAfter(error);
      if (retrySeconds == null || attempt >= 2) break;
      await sleep((retrySeconds * 1000) + 150);
    }
  }
  throw lastError || new Error('Telegram copy failed');
}

function parseRetryAfter(error) {
  const text = String(error?.message || error);
  const match = text.match(/retry\s+after\s+(\d+)/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

async function resolveDestination() {
  const dbDestination = await getSetting('destination_chat_id').catch(() => null);
  return dbDestination || process.env.DESTINATION_CHAT_ID || null;
}

async function claimWorkerLock(chatId, batchId) {
  const key = `sendall_worker_lock:${chatId}`;
  const current = await getSetting(key).catch(() => null);
  const age = current?.at ? Date.now() - Date.parse(current.at) : Infinity;

  if (
    current?.token
    && String(current.batch_id || '') === String(batchId)
    && Number.isFinite(age)
    && age >= 0
    && age < WORKER_LOCK_TTL_MS
  ) {
    return { claimed: false, token: current.token };
  }

  const token = makeToken();
  await setSetting(key, {
    token,
    batch_id: String(batchId),
    at: new Date().toISOString(),
  });
  const confirmed = await getSetting(key).catch(() => null);
  return {
    claimed: confirmed?.token === token && String(confirmed?.batch_id || '') === String(batchId),
    token,
  };
}

async function releaseWorkerLock(chatId, batchId, token) {
  const key = `sendall_worker_lock:${chatId}`;
  const current = await getSetting(key).catch(() => null);
  if (
    current?.token === token
    && String(current?.batch_id || '') === String(batchId)
  ) {
    await setSetting(key, null);
  }
}

async function saveWorkerError(chatId, batchId, error) {
  const batch = await getActiveSendBatch(chatId).catch(() => null);
  if (!batch || String(batch.id) !== String(batchId)) return;
  await saveActiveSendBatch(chatId, {
    ...batch,
    worker_error: String(error?.message || error).slice(0, 1000),
    worker_error_at: new Date().toISOString(),
  }).catch(() => {});
}

function remainingInBatch(batch) {
  if (!batch || batch.completed || !Array.isArray(batch.item_ids)) return 0;
  return Math.max(0, batch.item_ids.length - Number(batch.next_index || 0));
}

function makeToken() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}_${Math.random().toString(36).slice(2, 12)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
