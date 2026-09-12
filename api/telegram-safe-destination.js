import mainHandler from './telegram.js';
import { isAdminMessage } from '../lib/telegram.js';
import { getSetting, listQueueItems, setSetting } from '../lib/store.js';

const SAFE_WEBHOOK_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram-safe-destination';
const RESET_PENDING_PREFIX = 'resetbatch_pending:';
const RESET_PENDING_TTL_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Keep Telegram pinned to this wrapper. The legacy main handler still has an
  // old self-heal target, so we re-assert the safe endpoint before and after any
  // fallback into the legacy handler.
  await ensureSafeWebhook().catch(() => {});

  if (req.method !== 'POST') {
    return runMainSafely(req, res);
  }

  const update = req.body || {};
  const message = update.message;
  const query = update.callback_query;

  if (message?.chat?.type === 'private' && isAdminMessage(message)) {
    const text = String(message.text || '').trim();
    const chatId = message.chat.id;

    if (isCommand(text, 'menu')) return showMenu(chatId, res);
    if (isCommand(text, 'stop')) return hardStop(chatId, res);
    if (isCommand(text, 'resetbatch')) return prepareResetBatch(chatId, res);
  }

  if (query?.message && isAdminMessage({ from: query.from })) {
    const chatId = query.message.chat.id;
    const data = String(query.data || '');

    if (data === 'hard_resume') return resumeFromButton(chatId, query, req, res);
    if (data === 'resetbatch_confirm') return confirmResetBatch(chatId, query, res);
    if (data === 'resetbatch_cancel') return cancelResetBatch(chatId, query, res);
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
    '/stop — hard stop batch yang tengah jalan',
    '/resume — sambung baki batch yang sama',
    '/resetbatch — stop + delete mesej batch latest dari group',
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

async function hardStop(chatId, res) {
  const pausedAt = new Date().toISOString();
  await setSetting(`send_paused:${chatId}`, {
    paused: true,
    hard_stop: true,
    paused_at: pausedAt,
  });

  let batch = await getSetting(`active_send_batch:${chatId}`).catch(() => null);
  if (batch) {
    batch = {
      ...batch,
      hard_stopped: true,
      hard_stopped_at: pausedAt,
      updated_at: pausedAt,
    };
    await setSetting(`active_send_batch:${chatId}`, batch).catch(() => {});
  }

  const total = Array.isArray(batch?.item_ids) ? batch.item_ids.length : 0;
  const nextIndex = Math.max(0, Number(batch?.next_index || 0));
  const remaining = batch?.completed ? 0 : Math.max(0, total - nextIndex);
  const sent = Math.max(0, Number(batch?.sent || 0));

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: total
      ? `⛔ HARD STOP\nBatch dihentikan. ${sent} sent · ${remaining} remaining.`
      : '⛔ HARD STOP\nSemua SEND baru ditahan. Tak ada batch aktif sekarang.',
    reply_markup: {
      inline_keyboard: [[
        { text: '▶️ RESUME', callback_data: 'hard_resume' },
        { text: '🗑 RESET BATCH', callback_data: 'resetbatch_confirm' },
      ]],
    },
  });

  return res.status(200).json({ ok: true, hard_stopped: true, sent, remaining });
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
    text: `⚠️ RESET BATCH\nBatch: ${prepared.batchId}\nJumpa ${prepared.count} mesej yang batch ni berjaya hantar ke group.\n\nDelete untuk semua ahli group?`,
    reply_markup: {
      inline_keyboard: [[
        { text: `🗑 DELETE ${prepared.count}`, callback_data: 'resetbatch_confirm' },
        { text: 'BATAL', callback_data: 'resetbatch_cancel' },
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

  const destination = batch.destination || await getSetting('destination_chat_id').catch(() => null) || process.env.DESTINATION_CHAT_ID;
  if (!destination) {
    return { ok: false, reason: 'no_destination', message: 'Destination group tak jumpa.' };
  }

  const createdAtMs = Date.parse(batch.created_at || 0);
  const rows = await listQueueItems(chatId, 1000).catch(() => []);
  const itemIds = new Set(batch.item_ids.map(String));
  const messageIds = [];

  for (const row of rows || []) {
    if (!itemIds.has(String(row.id))) continue;
    if (String(row.destination_chat_id || '') !== String(destination)) continue;
    if (!row.destination_message_id || !row.sent_at) continue;

    const sentAtMs = Date.parse(row.sent_at);
    if (Number.isFinite(createdAtMs) && Number.isFinite(sentAtMs) && sentAtMs < createdAtMs) continue;
    messageIds.push(Number(row.destination_message_id));
  }

  const uniqueIds = [...new Set(messageIds.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
  if (!uniqueIds.length) {
    return { ok: false, reason: 'no_sent_messages', message: 'Batch latest tak ada mesej berjaya dihantar yang selamat untuk delete.' };
  }

  const snapshot = {
    batch_id: String(batch.id || ''),
    destination_chat_id: String(destination),
    message_ids: uniqueIds,
    prepared_at: new Date().toISOString(),
  };
  await setSetting(`${RESET_PENDING_PREFIX}${chatId}`, snapshot);

  return { ok: true, batchId: snapshot.batch_id || 'latest', count: uniqueIds.length };
}

async function confirmResetBatch(chatId, query, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  let pending = await getSetting(`${RESET_PENDING_PREFIX}${chatId}`).catch(() => null);
  if (!pending?.message_ids?.length) {
    const prepared = await buildResetSnapshot(chatId);
    if (!prepared.ok) {
      await rawBot('sendMessage', { chat_id: chatId, text: prepared.message });
      return res.status(200).json({ ok: true, deleted: 0, reason: prepared.reason });
    }
    pending = await getSetting(`${RESET_PENDING_PREFIX}${chatId}`).catch(() => null);
  }

  const preparedAt = Date.parse(pending?.prepared_at || 0);
  if (!Number.isFinite(preparedAt) || Date.now() - preparedAt > RESET_PENDING_TTL_MS) {
    await setSetting(`${RESET_PENDING_PREFIX}${chatId}`, null).catch(() => {});
    await rawBot('sendMessage', { chat_id: chatId, text: 'Confirmation RESET BATCH dah expired. Hantar /resetbatch semula.' });
    return res.status(200).json({ ok: true, deleted: 0, expired: true });
  }

  const ids = [...new Set((pending.message_ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const destination = pending.destination_chat_id;
  const result = await deleteGroupMessages(destination, ids);

  const batch = await getSetting(`active_send_batch:${chatId}`).catch(() => null);
  if (batch && String(batch.id || '') === String(pending.batch_id || '')) {
    await setSetting(`active_send_batch:${chatId}`, {
      ...batch,
      completed: true,
      next_index: Array.isArray(batch.item_ids) ? batch.item_ids.length : Number(batch.next_index || 0),
      rolled_back: true,
      rolled_back_at: new Date().toISOString(),
      rolled_back_deleted: result.deleted,
      updated_at: new Date().toISOString(),
    }).catch(() => {});
  }

  await setSetting(`${RESET_PENDING_PREFIX}${chatId}`, null).catch(() => {});

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: result.failed
      ? `🗑 RESET BATCH selesai. ${result.deleted} mesej deleted untuk semua · ${result.failed} gagal delete.`
      : `🗑 RESET BATCH selesai. ${result.deleted} mesej deleted untuk semua ahli group.`,
  });

  return res.status(200).json({ ok: true, deleted: result.deleted, failed: result.failed });
}

async function cancelResetBatch(chatId, query, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
  await setSetting(`${RESET_PENDING_PREFIX}${chatId}`, null).catch(() => {});
  await rawBot('sendMessage', { chat_id: chatId, text: 'RESET BATCH dibatalkan. SEND masih STOP.' });
  return res.status(200).json({ ok: true, cancelled: true });
}

async function resumeFromButton(chatId, query, req, res) {
  await rawBot('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
  await setSetting(`send_paused:${chatId}`, {
    paused: false,
    hard_stop: false,
    resumed_at: new Date().toISOString(),
  });

  const shadow = createShadowResponse();
  await mainHandler({
    ...req,
    method: 'POST',
    body: {
      message: {
        message_id: query.message?.message_id || 0,
        from: query.from,
        chat: query.message.chat,
        date: Math.floor(Date.now() / 1000),
        text: '/resume',
      },
    },
  }, shadow).catch(async (error) => {
    await rawBot('sendMessage', { chat_id: chatId, text: `Resume gagal: ${String(error?.message || error).slice(0, 500)}` }).catch(() => {});
  });

  await ensureSafeWebhook().catch(() => {});
  return res.status(200).json(shadow.body || { ok: true, resumed: true });
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

async function deleteGroupMessages(chatId, messageIds) {
  let deleted = 0;
  let failed = 0;

  for (let i = 0; i < messageIds.length; i += 100) {
    const chunk = messageIds.slice(i, i + 100);
    const bulk = await rawBot('deleteMessages', {
      chat_id: chatId,
      message_ids: chunk,
    }).catch(() => null);

    if (bulk === true) {
      deleted += chunk.length;
      continue;
    }

    for (const messageId of chunk) {
      const one = await rawBot('deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
      }).catch(() => null);
      if (one === true) deleted += 1;
      else failed += 1;
    }
  }

  return { deleted, failed };
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
