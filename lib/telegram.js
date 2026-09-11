import { getQueueItem, getSetting, setSetting } from './store.js';

let callbackWebhookEnsured = false;
const STABLE_WEBHOOK_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram';

export async function telegram(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  // api/telegram.js historically deletes the old preview before rebuilding it.
  // For the currently focused item we now keep that message alive so the next
  // copyMessage call can edit the SAME media message in place instead.
  if (method === 'deleteMessage' && await isActivePreviewRefreshDelete(payload)) {
    return true;
  }

  let result = null;
  let editedExistingPreview = false;

  // A preview refresh should not create another Telegram message. If the item
  // already has a preview_message_id, edit that media message's caption and
  // inline keyboard in place. The photo/file itself stays exactly where it is.
  if (method === 'copyMessage' && isOwnerPreview(payload)) {
    const edited = await tryEditExistingOwnerPreview(token, payload);
    if (edited) {
      result = edited;
      editedExistingPreview = true;
    }
  }

  if (!editedExistingPreview) {
    result = await rawTelegram(token, method, payload);
  }

  // All inline buttons depend on callback_query updates. Always point Telegram
  // at the one stable production alias. Do not trust TELEGRAM_WEBHOOK_URL,
  // VERCEL_URL or VERCEL_PROJECT_PRODUCTION_URL here because any one of those
  // can contain an immutable/old deployment hostname and make every button look dead.
  if (method !== 'setWebhook') {
    await ensureCallbackWebhookSupport(token).catch((error) => {
      console.error('Webhook callback self-heal failed:', error?.message || error);
    });
  }

  // After a new/updated media preview, tell the owner when the caption structure
  // looks unfamiliar. This never blocks the workflow.
  if (method === 'copyMessage' && isOwnerPreview(payload)) {
    await maybeSendFormatLearningNotice(payload).catch((error) => {
      console.error('Format learning notice failed:', error);
    });
  }

  return result;
}

export async function repairTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  const result = await rawTelegram(token, 'setWebhook', {
    url: STABLE_WEBHOOK_URL,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  });

  callbackWebhookEnsured = true;

  // Persist a sanitized snapshot so we can prove what Telegram is actually using
  // without exposing the bot token or depending on Vercel log access.
  let info = null;
  try {
    const rawInfo = await rawTelegram(token, 'getWebhookInfo', {});
    info = {
      url: rawInfo?.url || null,
      pending_update_count: rawInfo?.pending_update_count ?? null,
      allowed_updates: rawInfo?.allowed_updates || null,
      last_error_date: rawInfo?.last_error_date || null,
      last_error_message: rawInfo?.last_error_message || null,
      checked_at: new Date().toISOString(),
    };
    await setSetting('telegram_webhook_debug', info).catch(() => {});
  } catch (error) {
    await setSetting('telegram_webhook_debug', {
      url: STABLE_WEBHOOK_URL,
      checked_at: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 500),
    }).catch(() => {});
  }

  return { ok: Boolean(result), url: STABLE_WEBHOOK_URL, info };
}

async function rawTelegram(token, method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || 'Unknown error'}`);
  }
  return data.result;
}

async function tryEditExistingOwnerPreview(token, payload) {
  const itemId = extractItemId(payload.reply_markup);
  if (!itemId) return null;

  const item = await getQueueItem(itemId).catch(() => null);
  if (!item?.preview_message_id) return null;

  try {
    return await rawTelegram(token, 'editMessageCaption', {
      chat_id: payload.chat_id,
      message_id: item.preview_message_id,
      caption: payload.caption || '',
      parse_mode: payload.parse_mode || undefined,
      reply_markup: payload.reply_markup,
    });
  } catch (error) {
    // If the old preview was manually deleted / too old / otherwise cannot be
    // edited, fall back to the normal copyMessage path and make a fresh preview.
    console.error('Edit existing preview failed, falling back to copy:', error?.message || error);
    return null;
  }
}

async function isActivePreviewRefreshDelete(payload) {
  if (!payload?.chat_id || !payload?.message_id) return false;

  const state = await getSetting('admin_state').catch(() => null);
  if (state?.mode !== 'FOCUS_ITEM' || !state?.item_id) return false;

  const item = await getQueueItem(state.item_id).catch(() => null);
  if (!item?.preview_message_id) return false;

  const deletingPreview = String(item.preview_message_id) === String(payload.message_id);
  const deletingOriginalSource = String(item.source_message_id) === String(payload.message_id);
  return deletingPreview && !deletingOriginalSource;
}

async function ensureCallbackWebhookSupport(token) {
  if (callbackWebhookEnsured) return;

  // Never let a preview deployment steal the live Telegram webhook.
  const vercelEnv = String(process.env.VERCEL_ENV || '').trim();
  if (vercelEnv && vercelEnv !== 'production') return;

  callbackWebhookEnsured = true;
  try {
    await rawTelegram(token, 'setWebhook', {
      url: STABLE_WEBHOOK_URL,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
  } catch (error) {
    callbackWebhookEnsured = false;
    throw error;
  }
}

async function maybeSendFormatLearningNotice(payload) {
  const notice = await getSetting('format_learning_notice');
  if (!notice?.unknown) return;

  const detectedAt = new Date(notice.detected_at || 0).getTime();
  if (!detectedAt || Date.now() - detectedAt > 90_000) {
    await setSetting('format_learning_notice', null);
    return;
  }

  const itemId = extractItemId(payload.reply_markup);
  if (itemId) {
    await setSetting('admin_state', { mode: 'FOCUS_ITEM', item_id: itemId });
  }
  await setSetting('format_learning_notice', null);

  await telegram('sendMessage', {
    chat_id: payload.chat_id,
    text: 'Format ni nampak baru dan aku belum cukup belajar corak macam ni lagi. Aku tetap dah buat preview sementara. Kalau ada yang salah, cakap je macam biasa apa yang patut aku ambil, buang atau kekalkan — aku akan buat terus dan boleh belajar daripada correction tu.',
  });
}

function isOwnerPreview(payload) {
  if (!payload?.reply_markup?.inline_keyboard) return false;
  if (String(payload.chat_id) !== String(payload.from_chat_id)) return false;
  return payload.reply_markup.inline_keyboard
    .flat()
    .some((button) => {
      const data = String(button?.callback_data || '');
      return data.startsWith('send:') || data.startsWith('teach:');
    });
}

function extractItemId(replyMarkup) {
  const buttons = replyMarkup?.inline_keyboard?.flat?.() || [];
  for (const button of buttons) {
    const data = String(button?.callback_data || '');
    if (data.startsWith('send:')) return data.slice('send:'.length) || null;
    if (data.startsWith('teach:')) return data.slice('teach:'.length) || null;
  }
  return null;
}

export function isAdminMessage(message) {
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || '').trim();
  return Boolean(adminId && message?.from?.id && String(message.from.id) === adminId);
}

export function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}
