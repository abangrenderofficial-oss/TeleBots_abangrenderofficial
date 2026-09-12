import {
  getBatch,
  getLatestBatch,
  markBatchMessagesDeleted,
  markBatchRolledBack,
  stopAllRunningBatches,
} from '../../explicit-batches.js';
import { getSetting, listQueueItems, setSetting } from '../../store.js';
import { answerCallback, rawBot, sendText } from '../core/telegram-client.js';
import { resolveDestination } from './shared.js';

const RESET_TTL_MS = 10 * 60 * 1000;
const LEGACY_LOOKBACK_MS = 15 * 60 * 1000;
const CLEAR_PENDING_ATTEMPTS = 3;

export async function prepareLatestReset({ chatId, res }) {
  await hardPause(chatId);
  const latest = await getLatestBatch(chatId).catch(() => null);
  if (latest) return prepareExactReset({ chatId, batchId: latest.id, res });
  return prepareLegacyReset({ chatId, res });
}

export async function prepareExactReset({ chatId, batchId, query = null, res }) {
  if (query?.id) await answerCallback(query.id).catch(() => {});
  await hardPause(chatId);

  const batch = await getBatch(batchId).catch(() => null);
  if (!batch || String(batch.admin_chat_id) !== String(chatId)) {
    await sendText(chatId, 'Batch tu tak jumpa.');
    return res.status(200).json({ ok: true, reset: false, reason: 'missing_batch' });
  }

  const allIds = await getExactBatchMessageIds(batch.id);
  const processed = await getSetting(`reset_exact_processed:${batch.id}`).catch(() => null);
  const done = new Set(Array.isArray(processed?.message_ids) ? processed.message_ids.map(Number) : []);
  const ids = allIds.filter((id) => !done.has(id));

  if (!ids.length) {
    await sendText(
      chatId,
      batch.status === 'ROLLED_BACK'
        ? `🗑 Batch ${batch.id} memang dah di-reset.`
        : `Batch ${batch.id} tak ada lagi mesej tracked yang belum diproses delete.`,
    );
    return res.status(200).json({ ok: true, reset: false, reason: 'nothing_to_delete' });
  }

  await setSetting(`reset_exact_pending:${chatId}`, {
    batch_id: batch.id,
    destination_chat_id: batch.destination_chat_id,
    message_ids: ids,
    prepared_at: new Date().toISOString(),
  });

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: `⚠️ RESET BATCH\nBatch: ${batch.id}\nExact tracked: ${ids.length} mesej.\n\nDelete untuk semua ahli group?`,
    reply_markup: {
      inline_keyboard: [[
        { text: `🗑 DELETE ${ids.length}`, callback_data: `reset_exact_confirm:${batch.id}` },
        { text: 'BATAL', callback_data: `reset_exact_cancel:${batch.id}` },
      ]],
    },
  });

  return res.status(200).json({ ok: true, reset: true, batch_id: batch.id, count: ids.length });
}

export async function confirmExactReset({ chatId, batchId, query, res }) {
  await answerCallback(query.id).catch(() => {});

  const pendingKey = `reset_exact_pending:${chatId}`;
  const pending = await getSetting(pendingKey).catch(() => null);
  if (!pending || String(pending.batch_id) !== String(batchId)) {
    await sendText(chatId, 'Confirmation RESET BATCH dah tak valid. Hantar /resetbatch semula.');
    return res.status(200).json({ ok: true, deleted: 0, reason: 'invalid_pending' });
  }

  const preparedAt = Date.parse(pending.prepared_at || 0);
  if (!Number.isFinite(preparedAt) || Date.now() - preparedAt > RESET_TTL_MS) {
    await clearSetting(pendingKey).catch(() => {});
    await sendText(chatId, 'Confirmation RESET BATCH dah expired. Hantar /resetbatch semula.');
    return res.status(200).json({ ok: true, deleted: 0, expired: true });
  }

  const oldProcessed = await getSetting(`reset_exact_processed:${batchId}`).catch(() => null);
  const processedSet = new Set(Array.isArray(oldProcessed?.message_ids) ? oldProcessed.message_ids.map(Number) : []);
  const ids = uniqueIds(pending.message_ids).filter((id) => !processedSet.has(id));

  // A callback can be delivered twice. Never ask Telegram to delete the same
  // exact occurrence again after it was already confirmed successfully.
  if (!ids.length) {
    await clearSetting(pendingKey).catch(() => {});
    const allIds = await getExactBatchMessageIds(batchId);
    const remaining = allIds.filter((id) => !processedSet.has(id));
    if (!remaining.length) await markBatchRolledBack(batchId).catch(() => {});
    await sendText(chatId, `🗑 RESET BATCH ${batchId} memang dah diproses.`);
    return res.status(200).json({ ok: true, deleted: 0, already_processed: true });
  }

  const result = await deleteGroupMessages(pending.destination_chat_id, ids);
  for (const id of result.successfulIds) processedSet.add(id);

  await setSetting(`reset_exact_processed:${batchId}`, {
    message_ids: [...processedSet].sort((a, b) => a - b),
    updated_at: new Date().toISOString(),
  });
  await markBatchMessagesDeleted(batchId, result.successfulIds).catch(() => {});
  await clearSetting(pendingKey).catch(() => {});

  const allIds = await getExactBatchMessageIds(batchId);
  const remaining = allIds.filter((id) => !processedSet.has(id));
  if (!remaining.length) await markBatchRolledBack(batchId).catch(() => {});

  await sendText(
    chatId,
    result.failedIds.length
      ? `🗑 RESET BATCH ${batchId}: ${result.successfulIds.length} deleted untuk semua · ${result.failedIds.length} gagal. Hantar /resetbatch untuk retry baki.`
      : `🗑 RESET BATCH ${batchId} selesai. ${result.successfulIds.length} mesej deleted untuk semua ahli group.`,
  );

  return res.status(200).json({ ok: true, deleted: result.successfulIds.length, failed: result.failedIds.length });
}

export async function cancelExactReset({ chatId, query, res }) {
  await answerCallback(query.id).catch(() => {});
  await clearSetting(`reset_exact_pending:${chatId}`).catch(() => {});
  await sendText(chatId, 'RESET BATCH dibatalkan. SEND masih STOP.');
  return res.status(200).json({ ok: true, cancelled: true });
}

export async function confirmLegacyReset({ chatId, query, res }) {
  await answerCallback(query.id).catch(() => {});
  const pendingKey = `reset_legacy_pending:${chatId}`;
  const pending = await getSetting(pendingKey).catch(() => null);
  if (!pending?.message_ids?.length) return prepareLegacyReset({ chatId, res });

  const preparedAt = Date.parse(pending.prepared_at || 0);
  if (!Number.isFinite(preparedAt) || Date.now() - preparedAt > RESET_TTL_MS) {
    await clearSetting(pendingKey).catch(() => {});
    await sendText(chatId, 'Confirmation legacy reset dah expired. Hantar /resetbatch semula.');
    return res.status(200).json({ ok: true, expired: true });
  }

  const processed = await getSetting(pending.processed_key).catch(() => null);
  const set = new Set(Array.isArray(processed?.message_ids) ? processed.message_ids.map(Number) : []);
  const ids = uniqueIds(pending.message_ids).filter((id) => !set.has(id));

  if (!ids.length) {
    await clearSetting(pendingKey).catch(() => {});
    await sendText(chatId, '🗑 Legacy recovery untuk confirmation ini memang dah diproses.');
    return res.status(200).json({ ok: true, deleted: 0, already_processed: true });
  }

  const result = await deleteGroupMessages(pending.destination_chat_id, ids);
  for (const id of result.successfulIds) set.add(id);
  await setSetting(pending.processed_key, {
    message_ids: [...set].sort((a, b) => a - b),
    updated_at: new Date().toISOString(),
  });
  await clearSetting(pendingKey).catch(() => {});

  await sendText(
    chatId,
    result.failedIds.length
      ? `🗑 Legacy recovery: ${result.successfulIds.length} deleted · ${result.failedIds.length} gagal. Hantar /resetbatch untuk baki.`
      : `🗑 Legacy recovery selesai: ${result.successfulIds.length} mesej deleted untuk semua ahli group.`,
  );
  return res.status(200).json({ ok: true, deleted: result.successfulIds.length, failed: result.failedIds.length });
}

export async function cancelLegacyReset({ chatId, query, res }) {
  await answerCallback(query.id).catch(() => {});
  await clearSetting(`reset_legacy_pending:${chatId}`).catch(() => {});
  await sendText(chatId, 'RESET BATCH dibatalkan. SEND masih STOP.');
  return res.status(200).json({ ok: true, cancelled: true });
}

async function prepareLegacyReset({ chatId, res }) {
  const prepared = await buildLegacySnapshot(chatId);
  if (!prepared.ok) {
    await sendText(chatId, prepared.message);
    return res.status(200).json({ ok: true, legacy_reset: false, reason: prepared.reason });
  }

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: `⚠️ LEGACY BATCH RECOVERY\nBatch lama: ${prepared.batchId}\nBaki tracked: ${prepared.count}\n\nDelete untuk semua ahli group?`,
    reply_markup: {
      inline_keyboard: [[
        { text: `🗑 DELETE ${prepared.count}`, callback_data: 'resetbatch_confirm' },
        { text: 'BATAL', callback_data: 'resetbatch_cancel' },
      ]],
    },
  });
  return res.status(200).json({ ok: true, legacy_reset: true, count: prepared.count });
}

async function hardPause(chatId) {
  await setSetting(`send_paused:${chatId}`, {
    paused: true,
    hard_stop: true,
    paused_at: new Date().toISOString(),
  });
  await stopAllRunningBatches(chatId).catch(() => []);
}

async function getExactBatchMessageIds(batchId) {
  const [ledger, items] = await Promise.all([
    supabaseRequest(`/send_batch_messages?batch_id=eq.${encodeURIComponent(String(batchId))}&select=destination_message_id`),
    supabaseRequest(`/send_batch_items?batch_id=eq.${encodeURIComponent(String(batchId))}&status=eq.SENT&destination_message_id=not.is.null&select=destination_message_id`),
  ]);

  return uniqueIds([...(ledger || []), ...(items || [])].map((row) => row.destination_message_id)).sort((a, b) => a - b);
}

async function buildLegacySnapshot(chatId) {
  const batch = await getSetting(`active_send_batch:${chatId}`).catch(() => null);
  if (!batch || !Array.isArray(batch.item_ids) || !batch.item_ids.length) {
    return { ok: false, reason: 'no_batch', message: 'Tak ada batch latest yang boleh di-reset.' };
  }

  const destination = batch.destination || await resolveDestination();
  if (!destination) return { ok: false, reason: 'no_destination', message: 'Destination group tak jumpa.' };

  const rows = await listQueueItems(chatId, 1000);
  const itemIds = new Set(batch.item_ids.map(String));
  const items = (rows || []).filter((row) => itemIds.has(String(row.id)));
  const createdAtMs = Date.parse(batch.created_at || 0);
  const windowStart = Number.isFinite(createdAtMs) ? createdAtMs - LEGACY_LOOKBACK_MS : 0;

  const sourcePairs = new Set();
  const tracked = new Set();
  for (const row of items) {
    sourcePairs.add(`${String(row.source_chat_id)}:${Number(row.source_message_id)}`);
    if (String(row.destination_chat_id || '') !== String(destination)) continue;
    const sentAt = Date.parse(row.sent_at || 0);
    const mid = Number(row.destination_message_id);
    if (windowStart && Number.isFinite(sentAt) && sentAt < windowStart) continue;
    if (Number.isInteger(mid) && mid > 0) tracked.add(mid);
  }

  const dedupeRows = await supabaseRequest(
    `/telegram_send_dedupe?destination_chat_id=eq.${encodeURIComponent(String(destination))}`
    + `&status=eq.SENT${windowStart ? `&updated_at=gte.${encodeURIComponent(new Date(windowStart).toISOString())}` : ''}`
    + '&select=source_chat_id,source_message_id,destination_message_id,updated_at',
  );
  for (const row of dedupeRows || []) {
    const pair = `${String(row.source_chat_id)}:${Number(row.source_message_id)}`;
    if (!sourcePairs.has(pair)) continue;
    const mid = Number(row.destination_message_id);
    if (Number.isInteger(mid) && mid > 0) tracked.add(mid);
  }

  const processedKey = `reset_legacy_processed:${String(batch.id || 'latest')}`;
  const processed = await getSetting(processedKey).catch(() => null);
  const processedIds = new Set(Array.isArray(processed?.message_ids) ? processed.message_ids.map(Number) : []);

  if (!processedIds.size && batch.rolled_back && Number(batch.rolled_back_deleted || 0) > 0 && Number.isFinite(createdAtMs)) {
    for (const row of items) {
      const sentAt = Date.parse(row.sent_at || 0);
      const mid = Number(row.destination_message_id);
      if (
        String(row.destination_chat_id || '') === String(destination)
        && Number.isFinite(sentAt)
        && sentAt >= createdAtMs
        && Number.isInteger(mid)
        && mid > 0
      ) {
        processedIds.add(mid);
      }
    }
    await setSetting(processedKey, {
      message_ids: [...processedIds],
      recovered_from_old_reset: true,
    });
  }

  const remaining = [...tracked].filter((id) => !processedIds.has(id)).sort((a, b) => a - b);
  if (!remaining.length) {
    return {
      ok: false,
      reason: 'nothing_remaining',
      message: 'Batch lama tak ada lagi tracked message yang belum diproses delete.',
    };
  }

  await setSetting(`reset_legacy_pending:${chatId}`, {
    batch_id: String(batch.id || ''),
    destination_chat_id: String(destination),
    message_ids: remaining,
    processed_key: processedKey,
    prepared_at: new Date().toISOString(),
  });

  return { ok: true, batchId: String(batch.id || 'legacy'), count: remaining.length };
}

async function deleteGroupMessages(chatId, messageIds) {
  const ids = uniqueIds(messageIds);
  const successfulIds = [];
  const failedIds = [];

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const bulk = await rawBot('deleteMessages', { chat_id: chatId, message_ids: chunk }).catch(() => null);
    if (bulk === true) {
      successfulIds.push(...chunk);
      continue;
    }

    for (const messageId of chunk) {
      const one = await rawBot('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null);
      if (one === true) successfulIds.push(messageId);
      else failedIds.push(messageId);
    }
  }
  return { successfulIds, failedIds };
}

function uniqueIds(values) {
  return [...new Set((values || [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
}

async function clearSetting(key) {
  let lastError = null;
  for (let attempt = 0; attempt < CLEAR_PENDING_ATTEMPTS; attempt += 1) {
    try {
      await supabaseRequest(`/bot_settings?key=eq.${encodeURIComponent(String(key))}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
      return true;
    } catch (error) {
      lastError = error;
      await sleep(100 * (attempt + 1));
    }
  }
  throw lastError || new Error(`Unable to clear setting ${key}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function supabaseRequest(path, options = {}) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Supabase is not configured');

  const response = await fetch(`${base}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase reset error ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
