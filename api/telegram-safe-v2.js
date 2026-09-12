import safeHandler from './telegram-safe-destination.js';
import { isAdminMessage } from '../lib/telegram.js';
import { getSetting, listQueueItems, setSetting } from '../lib/store.js';

const RESET_PENDING_PREFIX = 'resetbatch_v2_pending:';
const RESET_PROCESSED_PREFIX = 'resetbatch_v2_processed:';
const RESET_PENDING_TTL_MS = 10 * 60 * 1000;
const LOOKBACK_MS = 15 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return safeHandler(req, res);

  const update = req.body || {};
  const message = update.message;
  const query = update.callback_query;

  if (message?.chat?.type === 'private' && isAdminMessage(message)) {
    const text = String(message.text || '').trim();
    const chatId = message.chat.id;
    if (isCommand(text, 'resetbatch')) return prepareResetBatch(chatId, res);
  }

  if (query?.message && isAdminMessage({ from: query.from })) {
    const chatId = query.message.chat.id;
    const data = String(query.data || '');
    if (data === 'resetbatch_v2_confirm') return confirmResetBatch(chatId, query, res);
    if (data === 'resetbatch_v2_cancel') return cancelResetBatch(chatId, query, res);
  }

  return safeHandler(req, res);
}

function isCommand(text, command) {
  return new RegExp(`^/${command}(?:@\\w+)?(?:\\s|$)`, 'i').test(String(text || ''));
}

async function prepareResetBatch(chatId, res) {
  await setSetting(`send_paused:${chatId}`, {
    paused: true,
    hard_stop: true,
    paused_at: new Date().toISOString(),
  });

  const prepared = await buildResetSnapshot(chatId);
  if (!prepared.ok) {
    await rawBot('sendMessage', { chat_id: chatId, text: prepared.message });
    return res.status(200).json({ ok: true, resetbatch: false, reason: prepared.reason });
  }

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: `⚠️ RESET BATCH\nBatch: ${prepared.batchId}\nMasih ada ${prepared.count} mesej tracked dari batch ni yang belum diproses delete.\n\nDelete untuk semua ahli group?`,
    reply_markup: {
      inline_keyboard: [[
        { text: `🗑 DELETE ${prepared.count}`, callback_data: 'resetbatch_v2_confirm' },
        { text: 'BATAL', callback_data: 'resetbatch_v2_cancel' },
      ]],
    },
  });

  return res.status(200).json({ ok: true, resetbatch: true, count: prepared.count });
}

async function buildResetSnapshot(chatId) {
  const batch = await getSetting(`active_send_batch:${chatId}`).catch(() => null);
  if (!batch || !Array.isArray(batch.item_ids) || !batch.item_ids.length) {
    return { ok: false, reason: 'no_batch', message: 'Tak ada batch latest yang boleh di-reset.' };
  }

  const destination = batch.destination
    || await getSetting('destination_chat_id').catch(() => null)
    || process.env.DESTINATION_CHAT_ID;
  if (!destination) {
    return { ok: false, reason: 'no_destination', message: 'Destination group tak jumpa.' };
  }

  const rows = await listQueueItems(chatId, 1000).catch(() => []);
  const itemIds = new Set(batch.item_ids.map(String));
  const items = (rows || []).filter((row) => itemIds.has(String(row.id)));
  const createdAtMs = Date.parse(batch.created_at || 0);
  const windowStartMs = Number.isFinite(createdAtMs) ? createdAtMs - LOOKBACK_MS : 0;

  const queueIds = new Set();
  const sourcePairs = new Set();
  for (const row of items) {
    sourcePairs.add(`${String(row.source_chat_id)}:${Number(row.source_message_id)}`);
    if (String(row.destination_chat_id || '') !== String(destination)) continue;
    const sentAtMs = Date.parse(row.sent_at || 0);
    if (windowStartMs && (!Number.isFinite(sentAtMs) || sentAtMs < windowStartMs)) continue;
    const mid = Number(row.destination_message_id);
    if (Number.isInteger(mid) && mid > 0) queueIds.add(mid);
  }

  const dedupeRows = await listRecentDedupe(destination, windowStartMs).catch(() => []);
  const dedupeIds = new Set();
  for (const row of dedupeRows) {
    const pair = `${String(row.source_chat_id)}:${Number(row.source_message_id)}`;
    if (!sourcePairs.has(pair)) continue;
    const mid = Number(row.destination_message_id);
    if (Number.isInteger(mid) && mid > 0) dedupeIds.add(mid);
  }

  const tracked = new Set([...queueIds, ...dedupeIds]);

  const processedKey = `${RESET_PROCESSED_PREFIX}${String(batch.id || 'latest')}`;
  let processed = await getSetting(processedKey).catch(() => null);
  let processedIds = new Set(Array.isArray(processed?.message_ids) ? processed.message_ids.map(Number) : []);

  // Compatibility recovery for the first reset implementation. That version
  // only deleted queue_items whose sent_at was on/after batch.created_at. If it
  // already marked this batch rolled_back, derive those exact old IDs so a
  // second /resetbatch only targets the stragglers it missed.
  if (!processedIds.size && batch.rolled_back && Number(batch.rolled_back_deleted || 0) > 0 && Number.isFinite(createdAtMs)) {
    for (const row of items) {
      if (String(row.destination_chat_id || '') !== String(destination)) continue;
      const sentAtMs = Date.parse(row.sent_at || 0);
      const mid = Number(row.destination_message_id);
      if (Number.isFinite(sentAtMs) && sentAtMs >= createdAtMs && Number.isInteger(mid) && mid > 0) {
        processedIds.add(mid);
      }
    }
    await setSetting(processedKey, {
      batch_id: String(batch.id || ''),
      destination_chat_id: String(destination),
      message_ids: [...processedIds].sort((a, b) => a - b),
      recovered_from_legacy_reset: true,
      updated_at: new Date().toISOString(),
    }).catch(() => {});
  }

  const remainingIds = [...tracked]
    .filter((id) => !processedIds.has(id))
    .sort((a, b) => a - b);

  if (!remainingIds.length) {
    return {
      ok: false,
      reason: 'no_remaining_tracked',
      message: 'Batch latest tak ada lagi mesej tracked yang belum diproses delete.',
    };
  }

  const snapshot = {
    batch_id: String(batch.id || ''),
    destination_chat_id: String(destination),
    message_ids: remainingIds,
    tracked_total: tracked.size,
    processed_before: processedIds.size,
    prepared_at: new Date().toISOString(),
  };
  await setSetting(`${RESET_PENDING_PREFIX}${chatId}`, snapshot);

  return {
    ok: true,
    batchId: snapshot.batch_id || 'latest',
    count: remainingIds.length,
    trackedTotal: tracked.size,
    processedBefore: processedIds.size,
  };
}

async function confirmResetBatch(chatId, query, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  const pending = await getSetting(`${RESET_PENDING_PREFIX}${chatId}`).catch(() => null);
  if (!pending?.message_ids?.length) {
    await rawBot('sendMessage', { chat_id: chatId, text: 'Tak ada RESET BATCH pending. Hantar /resetbatch semula.' });
    return res.status(200).json({ ok: true, deleted: 0, reason: 'no_pending' });
  }

  const preparedAt = Date.parse(pending.prepared_at || 0);
  if (!Number.isFinite(preparedAt) || Date.now() - preparedAt > RESET_PENDING_TTL_MS) {
    await setSetting(`${RESET_PENDING_PREFIX}${chatId}`, null).catch(() => {});
    await rawBot('sendMessage', { chat_id: chatId, text: 'Confirmation RESET BATCH dah expired. Hantar /resetbatch semula.' });
    return res.status(200).json({ ok: true, deleted: 0, expired: true });
  }

  const ids = [...new Set((pending.message_ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const result = await deleteGroupMessages(pending.destination_chat_id, ids);

  const processedKey = `${RESET_PROCESSED_PREFIX}${String(pending.batch_id || 'latest')}`;
  const currentProcessed = await getSetting(processedKey).catch(() => null);
  const processedIds = new Set(Array.isArray(currentProcessed?.message_ids) ? currentProcessed.message_ids.map(Number) : []);
  for (const id of result.successfulIds) processedIds.add(id);
  await setSetting(processedKey, {
    batch_id: String(pending.batch_id || ''),
    destination_chat_id: String(pending.destination_chat_id || ''),
    message_ids: [...processedIds].sort((a, b) => a - b),
    updated_at: new Date().toISOString(),
  }).catch(() => {});

  await setSetting(`${RESET_PENDING_PREFIX}${chatId}`, null).catch(() => {});

  const failedText = result.failed ? ` · ${result.failed} gagal` : '';
  await rawBot('sendMessage', {
    chat_id: chatId,
    text: `🗑 RESET BATCH: Telegram terima delete untuk ${result.deleted} mesej tracked${failedText}.\nKalau masih nampak baki, hantar /resetbatch sekali lagi — bot akan cari tracked ID yang belum diproses, bukan ulang yang sama.`,
  });

  return res.status(200).json({ ok: true, deleted: result.deleted, failed: result.failed });
}

async function cancelResetBatch(chatId, query, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
  await setSetting(`${RESET_PENDING_PREFIX}${chatId}`, null).catch(() => {});
  await rawBot('sendMessage', { chat_id: chatId, text: 'RESET BATCH dibatalkan. SEND masih STOP.' });
  return res.status(200).json({ ok: true, cancelled: true });
}

async function listRecentDedupe(destination, windowStartMs) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return [];

  const params = new URLSearchParams();
  params.set('destination_chat_id', `eq.${String(destination)}`);
  params.set('status', 'eq.SENT');
  if (windowStartMs) params.set('updated_at', `gte.${new Date(windowStartMs).toISOString()}`);
  params.set('select', 'source_chat_id,source_message_id,destination_message_id,updated_at,status');
  params.set('limit', '1000');

  const response = await fetch(`${base}/rest/v1/telegram_send_dedupe?${params.toString()}`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
    },
  });
  if (!response.ok) throw new Error(`Supabase dedupe read failed: ${response.status}`);
  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function deleteGroupMessages(chatId, messageIds) {
  const successfulIds = [];
  let failed = 0;

  for (let i = 0; i < messageIds.length; i += 100) {
    const chunk = messageIds.slice(i, i + 100);
    const bulk = await rawBot('deleteMessages', {
      chat_id: chatId,
      message_ids: chunk,
    }).catch(() => null);

    if (bulk === true) {
      successfulIds.push(...chunk);
      continue;
    }

    for (const messageId of chunk) {
      const one = await rawBot('deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
      }).catch(() => null);
      if (one === true) successfulIds.push(messageId);
      else failed += 1;
    }
  }

  return { deleted: successfulIds.length, failed, successfulIds };
}

async function rawBot(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}
