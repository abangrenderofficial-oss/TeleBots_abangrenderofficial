import fastRecapHandler from './telegram-fast-recap.js';
import { telegram, isAdminMessage } from '../lib/telegram.js';
import {
  finishActiveSendBatch,
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

const SEND_ALL_SNAPSHOT_LIMIT = 1000;
const SEND_CHUNK_SIZE = 25;
const SEND_CHUNK_PAUSE_MS = 500;
const SAVE_EVERY = 5;
const WORKER_LOCK_TTL_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return fastRecapHandler(req, res);

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

  const lock = await claimWorkerLock(chatId);
  if (!lock.claimed) {
    // Callback/webhook retry or a second tap while the same SEND ALL is already
    // running. Do nothing so the destination cannot receive a second worker.
    return res.status(200).json({ ok: true, already_running: true });
  }

  try {
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

    // One owner tap creates ONE full snapshot. Item baru yang datang selepas
    // this moment will not join this batch automatically.
    let batch = await startActiveSendBatch(chatId, items, 'normal');
    batch.snapshot_total = items.length;
    batch.chunk_size = SEND_CHUNK_SIZE;
    batch.worker = 'sendall_v2';
    batch = await saveActiveSendBatch(chatId, batch);

    // Clear focus once for the whole batch instead of doing a DB write per item.
    await setSetting('admin_state', null).catch(() => {});

    const result = await continueFastSendAll(chatId, batch, destination);
    return res.status(200).json({ ok: true, ...result });
  } finally {
    await releaseWorkerLock(chatId, lock.token).catch(() => {});
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

async function continueFastSendAll(chatId, initialBatch, destination) {
  let batch = {
    ...initialBatch,
    item_ids: Array.isArray(initialBatch?.item_ids) ? initialBatch.item_ids : [],
    next_index: Number(initialBatch?.next_index || 0),
    sent: Number(initialBatch?.sent || 0),
    failed: Number(initialBatch?.failed || 0),
  };

  let processedSinceSave = 0;
  let processedInChunk = 0;

  for (let index = batch.next_index; index < batch.item_ids.length; index += 1) {
    if (await isSendPaused(chatId)) {
      batch.next_index = index;
      await saveActiveSendBatch(chatId, batch);
      return {
        paused: true,
        sent: batch.sent,
        failed: batch.failed,
        remaining: batch.item_ids.length - index,
      };
    }

    // Fresh read before every destination copy means any owner correction made
    // before this item reaches the front of the queue is the version that sends.
    const item = await getQueueItem(batch.item_ids[index]).catch(() => null);
    if (!item) {
      batch.next_index = index + 1;
      processedSinceSave += 1;
      processedInChunk += 1;
    } else {
      const status = String(item.status || '').toUpperCase();
      if (!['READY', 'FAILED'].includes(status)) {
        batch.next_index = index + 1;
        processedSinceSave += 1;
        processedInChunk += 1;
      } else {
        const result = await sendOneFast(item, destination);
        if (result.ok) batch.sent += 1;
        else batch.failed += 1;

        batch.next_index = index + 1;
        processedSinceSave += 1;
        processedInChunk += 1;
      }
    }

    // Save progress in small groups. If a function ever restarts between saves,
    // queue status + destination dedupe prevent the already-sent occurrence from
    // being duplicated in the group.
    if (processedSinceSave >= SAVE_EVERY || batch.next_index >= batch.item_ids.length) {
      batch = await saveActiveSendBatch(chatId, batch);
      processedSinceSave = 0;
    }

    // One SEND ALL still means ALL. Chunk boundaries only give Telegram/Vercel a
    // short breather; continuation is automatic and needs no second button tap.
    if (
      processedInChunk >= SEND_CHUNK_SIZE
      && batch.next_index < batch.item_ids.length
    ) {
      batch = await saveActiveSendBatch(chatId, batch);
      processedInChunk = 0;
      await sleep(SEND_CHUNK_PAUSE_MS);
    }
  }

  batch = await finishActiveSendBatch(chatId, batch);
  const failedText = batch.failed > 0 ? ` · ${batch.failed} failed` : '';
  await telegram('sendMessage', {
    chat_id: chatId,
    text: `✅ SEND ALL selesai · ${batch.sent} sent${failedText}`,
  });

  return {
    completed: true,
    sent: batch.sent,
    failed: batch.failed,
    total: batch.item_ids.length,
  };
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

async function claimWorkerLock(chatId) {
  const key = `sendall_worker_lock:${chatId}`;
  const current = await getSetting(key).catch(() => null);
  const age = current?.at ? Date.now() - Date.parse(current.at) : Infinity;
  if (current?.token && Number.isFinite(age) && age >= 0 && age < WORKER_LOCK_TTL_MS) {
    return { claimed: false, token: current.token };
  }

  const token = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await setSetting(key, { token, at: new Date().toISOString() });
  const confirmed = await getSetting(key).catch(() => null);
  return { claimed: confirmed?.token === token, token };
}

async function releaseWorkerLock(chatId, token) {
  const key = `sendall_worker_lock:${chatId}`;
  const current = await getSetting(key).catch(() => null);
  if (current?.token === token) await setSetting(key, null);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
