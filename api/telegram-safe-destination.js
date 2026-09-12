import { waitUntil } from '@vercel/functions';
import mainHandler from './telegram.js';
import { isAdminMessage } from '../lib/telegram.js';
import { buildResendBatchItems } from '../lib/send-control.js';
import { getSetting, listQueueItems, setSetting } from '../lib/store.js';
import {
  createExplicitBatch,
  getBatch,
  getLatestBatch,
  getRunningBatch,
  markBatchMessagesDeleted,
  markBatchRolledBack,
  resumeBatch,
  stopAllRunningBatches,
} from '../lib/explicit-batches.js';

const SAFE_WEBHOOK_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram-safe-destination';
const WORKER_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/send-batch-worker';
const RESET_TTL_MS = 10 * 60 * 1000;
const LEGACY_LOOKBACK_MS = 15 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return runMainSafely(req, res);

  const update = req.body || {};
  const message = update.message;
  const query = update.callback_query;

  if (message?.chat?.type === 'private' && isAdminMessage(message)) {
    const text = String(message.text || '').trim();
    const chatId = message.chat.id;

    if (isCommand(text, 'menu')) return showMenu(chatId, res);
    if (isCommand(text, 'stop')) return hardStop(chatId, res);
    if (isCommand(text, 'resume')) return resumeCommand(chatId, req, res);
    if (isCommand(text, 'resetbatch')) return prepareLatestReset(chatId, res);
  }

  if (query?.message && isAdminMessage({ from: query.from })) {
    const chatId = query.message.chat.id;
    const data = String(query.data || '');

    if (data === 'sendall') return startNormalBatch(chatId, query, res);
    if (data.startsWith('resendall:')) return startResendBatch(chatId, query, data.slice('resendall:'.length), res);
    if (data === 'hard_resume') return resumeFromButton(chatId, query, req, res);

    if (data.startsWith('reset_exact:')) {
      return prepareExactReset(chatId, data.slice('reset_exact:'.length), query, res);
    }
    if (data.startsWith('reset_exact_confirm:')) {
      return confirmExactReset(chatId, data.slice('reset_exact_confirm:'.length), query, res);
    }
    if (data.startsWith('reset_exact_cancel:')) {
      return cancelExactReset(chatId, query, res);
    }

    if (data === 'resetbatch_confirm') return confirmLegacyReset(chatId, query, res);
    if (data === 'resetbatch_cancel') return cancelLegacyReset(chatId, query, res);
  }

  return runMainSafely(req, res);
}

function isCommand(text, command) {
  return new RegExp(`^/${command}(?:@\\w+)?(?:\\s|$)`, 'i').test(String(text || ''));
}

async function showMenu(chatId, res) {
  const text = [
    '📋 BOT MENU',
    '',
    '🚨 SEND / BATCH',
    '/stop — hard stop semua batch yang tengah jalan',
    '/resume — sambung batch latest yang di-stop',
    '/resetbatch — delete mesej batch latest dari group',
    '',
    'Setiap kali tekan SEND ALL = 1 batch baru yang berasingan.',
    '',
    '📦 QUEUE / FILE',
    '/total — jumlah file + status',
    '/stats — statistik queue',
    '/pending — senarai item belum selesai',
    '/setcaption — set caption/footer global',
    '',
    '🧠 AI / MEMORY',
    '/memories — tengok memory',
    '/remember <ayat> — simpan memory',
    '/forget <id> — buang memory ikut ID',
    '/clearchat — clear chat history AI',
    '/aitest — test sambungan Gemini',
    '',
    '🔧 SYSTEM',
    '/connect — set destination (guna dalam group target)',
    '/whoami — tengok Telegram user ID',
    '/version — tengok build live',
    '/help — bantuan penggunaan bot',
    '/menu — buka menu ni semula',
  ].join('\n');

  await rawBot('sendMessage', { chat_id: chatId, text });
  return res.status(200).json({ ok: true, menu: true });
}

async function startNormalBatch(chatId, query, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  if (await isGloballyPaused(chatId)) {
    await rawBot('sendMessage', { chat_id: chatId, text: '⛔ SEND masih STOP. Guna /resume dulu.' });
    return res.status(200).json({ ok: true, blocked: 'paused' });
  }

  const running = await getRunningBatch(chatId).catch(() => null);
  if (running) {
    await rawBot('sendMessage', {
      chat_id: chatId,
      text: `⏳ Batch ${running.id} masih berjalan. Tunggu siap atau guna /stop dulu.`,
    });
    return res.status(200).json({ ok: true, blocked: 'batch_running', batch_id: running.id });
  }

  const destination = await resolveDestination();
  if (!destination) {
    await rawBot('sendMessage', { chat_id: chatId, text: 'Destination belum set. Dalam group target, hantar /connect sekali.' });
    return res.status(200).json({ ok: true, blocked: 'no_destination' });
  }

  const items = await buildNormalBatchItems(chatId, query.message?.message_id);
  if (!items.length) {
    await rawBot('sendMessage', { chat_id: chatId, text: 'Tak ada item READY/FAILED dari preview ni untuk SEND ALL.' });
    return res.status(200).json({ ok: true, blocked: 'no_items' });
  }

  const { batch, created } = await createExplicitBatch({
    adminChatId: chatId,
    triggerId: `callback:${query.id}`,
    mode: 'normal',
    destinationChatId: destination,
    items,
  });

  if (!created) {
    return res.status(200).json({ ok: true, duplicate_callback: true, batch_id: batch.id });
  }

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: `🚀 BATCH ${batch.id} mula · ${items.length} item`,
  }).catch(() => {});

  waitUntil(kickWorker(batch).catch((error) => {
    console.error('Initial batch worker kick failed:', error?.message || error);
  }));

  return res.status(200).json({ ok: true, batch_id: batch.id, count: items.length });
}

async function startResendBatch(chatId, query, anchorItemId, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  if (await isGloballyPaused(chatId)) {
    await rawBot('sendMessage', { chat_id: chatId, text: '⛔ SEND masih STOP. Guna /resume dulu.' });
    return res.status(200).json({ ok: true, blocked: 'paused' });
  }

  const running = await getRunningBatch(chatId).catch(() => null);
  if (running) {
    await rawBot('sendMessage', {
      chat_id: chatId,
      text: `⏳ Batch ${running.id} masih berjalan. Tunggu siap atau guna /stop dulu.`,
    });
    return res.status(200).json({ ok: true, blocked: 'batch_running', batch_id: running.id });
  }

  const destination = await resolveDestination();
  if (!destination) {
    await rawBot('sendMessage', { chat_id: chatId, text: 'Destination belum set. Dalam group target, hantar /connect sekali.' });
    return res.status(200).json({ ok: true, blocked: 'no_destination' });
  }

  const items = (await buildResendBatchItems(chatId, anchorItemId))
    .filter((item) => ['READY', 'FAILED', 'SENT'].includes(String(item.status || '').toUpperCase()));

  if (!items.length) {
    await rawBot('sendMessage', { chat_id: chatId, text: 'Tak ada item untuk RESEND ALL dari sini.' });
    return res.status(200).json({ ok: true, blocked: 'no_items' });
  }

  const { batch, created } = await createExplicitBatch({
    adminChatId: chatId,
    triggerId: `callback:${query.id}`,
    mode: 'resend',
    destinationChatId: destination,
    items,
  });

  if (!created) {
    return res.status(200).json({ ok: true, duplicate_callback: true, batch_id: batch.id });
  }

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: `🔁 BATCH ${batch.id} mula · ${items.length} item`,
  }).catch(() => {});

  waitUntil(kickWorker(batch).catch((error) => {
    console.error('Initial resend batch worker kick failed:', error?.message || error);
  }));

  return res.status(200).json({ ok: true, batch_id: batch.id, count: items.length });
}

async function buildNormalBatchItems(chatId, previewMessageId) {
  const rows = await listQueueItems(chatId, 1000);
  const anchor = (rows || []).find((row) => Number(row.preview_message_id) === Number(previewMessageId));
  if (!anchor) return [];

  return (rows || [])
    .filter((row) => String(row.admin_chat_id) === String(chatId))
    .filter((row) => String(row.source_chat_id) === String(anchor.source_chat_id))
    .filter((row) => Number(row.source_message_id) >= Number(anchor.source_message_id))
    .filter((row) => ['READY', 'FAILED'].includes(String(row.status || '').toUpperCase()))
    .sort((a, b) => {
      const byMessage = Number(a.source_message_id) - Number(b.source_message_id);
      if (Number.isFinite(byMessage) && byMessage !== 0) return byMessage;
      return Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
    });
}

async function hardStop(chatId, res) {
  const now = new Date().toISOString();
  await setSetting(`send_paused:${chatId}`, {
    paused: true,
    hard_stop: true,
    paused_at: now,
  });

  const stopped = await stopAllRunningBatches(chatId).catch(() => []);

  // Keep the old setting stopped too so a legacy invocation cannot continue.
  const legacy = await getSetting(`active_send_batch:${chatId}`).catch(() => null);
  if (legacy) {
    await setSetting(`active_send_batch:${chatId}`, {
      ...legacy,
      hard_stopped: true,
      hard_stopped_at: now,
      updated_at: now,
    }).catch(() => {});
  }

  const latest = stopped.length ? stopped.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] : await getLatestBatch(chatId).catch(() => null);
  const sent = Number(latest?.sent_count || 0);
  const total = Array.isArray(latest?.item_ids) ? latest.item_ids.length : 0;
  const remaining = Math.max(0, total - Number(latest?.next_index || 0));

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: stopped.length
      ? `⛔ HARD STOP\n${stopped.length} batch running dihentikan. Latest ${latest?.id || ''}: ${sent} sent · ${remaining} remaining.`
      : '⛔ HARD STOP\nSemua SEND baru ditahan. Tak ada batch explicit yang sedang berjalan.',
    reply_markup: {
      inline_keyboard: [[
        { text: '▶️ RESUME', callback_data: 'hard_resume' },
        latest?.id
          ? { text: '🗑 RESET BATCH', callback_data: `reset_exact:${latest.id}` }
          : { text: '🗑 RESET BATCH', callback_data: 'resetbatch_confirm' },
      ]],
    },
  });

  return res.status(200).json({ ok: true, hard_stopped: true, stopped_batches: stopped.length });
}

async function resumeCommand(chatId, req, res) {
  await setSetting(`send_paused:${chatId}`, {
    paused: false,
    hard_stop: false,
    resumed_at: new Date().toISOString(),
  });

  const latest = await getLatestBatch(chatId).catch(() => null);
  if (latest?.status === 'STOPPED') {
    const resumed = await resumeBatch(latest.id);
    if (resumed?.status === 'RUNNING') {
      await rawBot('sendMessage', { chat_id: chatId, text: `▶️ Batch ${resumed.id} sambung.` });
      waitUntil(kickWorker(resumed).catch((error) => console.error('Resume worker kick failed:', error?.message || error)));
      return res.status(200).json({ ok: true, resumed: true, batch_id: resumed.id });
    }
  }

  // No explicit stopped batch: keep compatibility with an old pre-upgrade batch.
  return resumeLegacy(chatId, req, res);
}

async function resumeFromButton(chatId, query, req, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
  return resumeCommand(chatId, req, res);
}

async function resumeLegacy(chatId, req, res) {
  const shadow = createShadowResponse();
  await mainHandler({
    ...req,
    method: 'POST',
    body: {
      message: {
        message_id: 0,
        from: { id: Number(process.env.ADMIN_TELEGRAM_ID || chatId) },
        chat: { id: chatId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/resume',
      },
    },
  }, shadow).catch(() => {});

  await ensureSafeWebhook().catch(() => {});
  if (!shadow.body) {
    await rawBot('sendMessage', { chat_id: chatId, text: '▶️ SEND aktif semula. Tak ada batch tergantung untuk disambung.' });
  }
  return res.status(200).json(shadow.body || { ok: true, resumed: false });
}

async function prepareLatestReset(chatId, res) {
  await setSetting(`send_paused:${chatId}`, {
    paused: true,
    hard_stop: true,
    paused_at: new Date().toISOString(),
  });
  await stopAllRunningBatches(chatId).catch(() => []);

  const latest = await getLatestBatch(chatId).catch(() => null);
  if (latest) return prepareExactReset(chatId, latest.id, null, res);

  return prepareLegacyReset(chatId, res);
}

async function prepareExactReset(chatId, batchId, query, res) {
  if (query?.id) await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  await setSetting(`send_paused:${chatId}`, {
    paused: true,
    hard_stop: true,
    paused_at: new Date().toISOString(),
  });
  await stopAllRunningBatches(chatId).catch(() => []);

  const batch = await getBatch(batchId).catch(() => null);
  if (!batch || String(batch.admin_chat_id) !== String(chatId)) {
    await rawBot('sendMessage', { chat_id: chatId, text: 'Batch tu tak jumpa.' });
    return res.status(200).json({ ok: true, reset: false, reason: 'missing_batch' });
  }

  const allIds = await getExactBatchMessageIds(batch.id);
  const processed = await getSetting(`reset_exact_processed:${batch.id}`).catch(() => null);
  const done = new Set(Array.isArray(processed?.message_ids) ? processed.message_ids.map(Number) : []);
  const ids = allIds.filter((id) => !done.has(id));

  if (!ids.length) {
    await rawBot('sendMessage', {
      chat_id: chatId,
      text: batch.status === 'ROLLED_BACK'
        ? `🗑 Batch ${batch.id} memang dah di-reset.`
        : `Batch ${batch.id} tak ada lagi mesej tracked yang belum diproses delete.`,
    });
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

async function confirmExactReset(chatId, batchId, query, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  const pending = await getSetting(`reset_exact_pending:${chatId}`).catch(() => null);
  if (!pending || String(pending.batch_id) !== String(batchId)) {
    await rawBot('sendMessage', { chat_id: chatId, text: 'Confirmation RESET BATCH dah tak valid. Hantar /resetbatch semula.' });
    return res.status(200).json({ ok: true, deleted: 0, reason: 'invalid_pending' });
  }

  const preparedAt = Date.parse(pending.prepared_at || 0);
  if (!Number.isFinite(preparedAt) || Date.now() - preparedAt > RESET_TTL_MS) {
    await setSetting(`reset_exact_pending:${chatId}`, null).catch(() => {});
    await rawBot('sendMessage', { chat_id: chatId, text: 'Confirmation RESET BATCH dah expired. Hantar /resetbatch semula.' });
    return res.status(200).json({ ok: true, deleted: 0, expired: true });
  }

  const ids = [...new Set((pending.message_ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const result = await deleteGroupMessages(pending.destination_chat_id, ids);

  const oldProcessed = await getSetting(`reset_exact_processed:${batchId}`).catch(() => null);
  const processedSet = new Set(Array.isArray(oldProcessed?.message_ids) ? oldProcessed.message_ids.map(Number) : []);
  for (const id of result.successfulIds) processedSet.add(id);
  await setSetting(`reset_exact_processed:${batchId}`, {
    message_ids: [...processedSet].sort((a, b) => a - b),
    updated_at: new Date().toISOString(),
  });

  await markBatchMessagesDeleted(batchId, result.successfulIds).catch(() => {});
  await setSetting(`reset_exact_pending:${chatId}`, null).catch(() => {});

  const allIds = await getExactBatchMessageIds(batchId);
  const remaining = allIds.filter((id) => !processedSet.has(id));
  if (!remaining.length) await markBatchRolledBack(batchId).catch(() => {});

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: result.failedIds.length
      ? `🗑 RESET BATCH ${batchId}: ${result.successfulIds.length} deleted untuk semua · ${result.failedIds.length} gagal. Hantar /resetbatch untuk retry baki.`
      : `🗑 RESET BATCH ${batchId} selesai. ${result.successfulIds.length} mesej deleted untuk semua ahli group.`,
  });

  return res.status(200).json({ ok: true, deleted: result.successfulIds.length, failed: result.failedIds.length });
}

async function cancelExactReset(chatId, query, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
  await setSetting(`reset_exact_pending:${chatId}`, null).catch(() => {});
  await rawBot('sendMessage', { chat_id: chatId, text: 'RESET BATCH dibatalkan. SEND masih STOP.' });
  return res.status(200).json({ ok: true, cancelled: true });
}

async function getExactBatchMessageIds(batchId) {
  const [ledger, items] = await Promise.all([
    supabaseRequest(`/send_batch_messages?batch_id=eq.${encodeURIComponent(String(batchId))}&select=destination_message_id`),
    supabaseRequest(`/send_batch_items?batch_id=eq.${encodeURIComponent(String(batchId))}&status=eq.SENT&destination_message_id=not.is.null&select=destination_message_id`),
  ]);

  return [...new Set([...(ledger || []), ...(items || [])]
    .map((row) => Number(row.destination_message_id))
    .filter((id) => Number.isInteger(id) && id > 0))]
    .sort((a, b) => a - b);
}

// One-time compatibility path for the corrupted batch created before explicit
// batch IDs existed. New batches NEVER use time windows for reset.
async function prepareLegacyReset(chatId, res) {
  const prepared = await buildLegacySnapshot(chatId);
  if (!prepared.ok) {
    await rawBot('sendMessage', { chat_id: chatId, text: prepared.message });
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

  const dedupeRows = await supabaseRequest(`/telegram_send_dedupe?destination_chat_id=eq.${encodeURIComponent(String(destination))}&status=eq.SENT${windowStart ? `&updated_at=gte.${encodeURIComponent(new Date(windowStart).toISOString())}` : ''}&select=source_chat_id,source_message_id,destination_message_id,updated_at`);
  for (const row of dedupeRows || []) {
    const pair = `${String(row.source_chat_id)}:${Number(row.source_message_id)}`;
    if (!sourcePairs.has(pair)) continue;
    const mid = Number(row.destination_message_id);
    if (Number.isInteger(mid) && mid > 0) tracked.add(mid);
  }

  const processedKey = `reset_legacy_processed:${String(batch.id || 'latest')}`;
  let processed = await getSetting(processedKey).catch(() => null);
  const processedIds = new Set(Array.isArray(processed?.message_ids) ? processed.message_ids.map(Number) : []);

  if (!processedIds.size && batch.rolled_back && Number(batch.rolled_back_deleted || 0) > 0 && Number.isFinite(createdAtMs)) {
    for (const row of items) {
      const sentAt = Date.parse(row.sent_at || 0);
      const mid = Number(row.destination_message_id);
      if (String(row.destination_chat_id || '') === String(destination)
        && Number.isFinite(sentAt) && sentAt >= createdAtMs
        && Number.isInteger(mid) && mid > 0) {
        processedIds.add(mid);
      }
    }
    await setSetting(processedKey, { message_ids: [...processedIds], recovered_from_old_reset: true });
  }

  const remaining = [...tracked].filter((id) => !processedIds.has(id)).sort((a, b) => a - b);
  if (!remaining.length) {
    return { ok: false, reason: 'nothing_remaining', message: 'Batch lama tak ada lagi tracked message yang belum diproses delete.' };
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

async function confirmLegacyReset(chatId, query, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
  const pending = await getSetting(`reset_legacy_pending:${chatId}`).catch(() => null);
  if (!pending?.message_ids?.length) {
    return prepareLegacyReset(chatId, res);
  }

  const preparedAt = Date.parse(pending.prepared_at || 0);
  if (!Number.isFinite(preparedAt) || Date.now() - preparedAt > RESET_TTL_MS) {
    await setSetting(`reset_legacy_pending:${chatId}`, null).catch(() => {});
    await rawBot('sendMessage', { chat_id: chatId, text: 'Confirmation legacy reset dah expired. Hantar /resetbatch semula.' });
    return res.status(200).json({ ok: true, expired: true });
  }

  const result = await deleteGroupMessages(pending.destination_chat_id, pending.message_ids);
  const processed = await getSetting(pending.processed_key).catch(() => null);
  const set = new Set(Array.isArray(processed?.message_ids) ? processed.message_ids.map(Number) : []);
  for (const id of result.successfulIds) set.add(id);
  await setSetting(pending.processed_key, { message_ids: [...set].sort((a, b) => a - b), updated_at: new Date().toISOString() });
  await setSetting(`reset_legacy_pending:${chatId}`, null).catch(() => {});

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: result.failedIds.length
      ? `🗑 Legacy recovery: ${result.successfulIds.length} deleted · ${result.failedIds.length} gagal. Hantar /resetbatch untuk baki.`
      : `🗑 Legacy recovery selesai: ${result.successfulIds.length} mesej deleted untuk semua ahli group.`,
  });
  return res.status(200).json({ ok: true, deleted: result.successfulIds.length, failed: result.failedIds.length });
}

async function cancelLegacyReset(chatId, query, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
  await setSetting(`reset_legacy_pending:${chatId}`, null).catch(() => {});
  await rawBot('sendMessage', { chat_id: chatId, text: 'RESET BATCH dibatalkan. SEND masih STOP.' });
  return res.status(200).json({ ok: true, cancelled: true });
}

async function kickWorker(batch) {
  const response = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batch_id: batch.id, worker_secret: batch.worker_secret }),
  });
  if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
  return response.json().catch(() => ({}));
}

async function isGloballyPaused(chatId) {
  const value = await getSetting(`send_paused:${chatId}`).catch(() => null);
  return Boolean(value === true || value?.paused);
}

async function resolveDestination() {
  return await getSetting('destination_chat_id').catch(() => null) || process.env.DESTINATION_CHAT_ID || null;
}

async function deleteGroupMessages(chatId, messageIds) {
  const ids = [...new Set((messageIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
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

async function runMainSafely(req, res) {
  const shadow = createShadowResponse();
  await mainHandler(req, shadow).catch((error) => {
    shadow.status(200).json({ ok: true, handled: false, error: String(error?.message || error).slice(0, 500) });
  });
  await ensureSafeWebhook().catch(() => {});

  for (const [name, value] of Object.entries(shadow.headers || {})) {
    try { res.setHeader(name, value); } catch {}
  }
  return res.status(shadow.statusCode || 200).json(shadow.body ?? { ok: true });
}

async function ensureSafeWebhook() {
  return rawBot('setWebhook', {
    url: SAFE_WEBHOOK_URL,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  });
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

function createShadowResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
    end(value) {
      this.body = value;
      return this;
    },
  };
}
