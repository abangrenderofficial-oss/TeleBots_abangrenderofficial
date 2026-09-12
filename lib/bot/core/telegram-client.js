export async function rawBot(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result;
}

export async function sendText(chatId, text, extra = {}) {
  return rawBot('sendMessage', {
    chat_id: chatId,
    text,
    ...extra,
  });
}

export async function answerCallback(callbackQueryId, extra = {}) {
  if (!callbackQueryId) return null;
  return rawBot('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...extra,
  });
}
