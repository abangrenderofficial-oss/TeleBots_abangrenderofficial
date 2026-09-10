import { getSetting, setSetting } from './store.js';

export async function telegram(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || 'Unknown error'}`);
  }

  // After a new media preview, tell the owner when the caption structure looks unfamiliar.
  // This never blocks the workflow; the AI keeps the item focused so the owner can teach it
  // just by continuing the conversation normally.
  if (method === 'copyMessage' && isOwnerPreview(payload)) {
    await maybeSendFormatLearningNotice(payload).catch((error) => {
      console.error('Format learning notice failed:', error);
    });
  }

  return data.result;
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
