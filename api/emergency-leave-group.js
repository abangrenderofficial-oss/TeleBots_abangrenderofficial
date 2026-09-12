export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'missing_token' });

  const chatId = '-1003005609440';
  const response = await fetch(`https://api.telegram.org/bot${token}/leaveChat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId }),
  });
  const data = await response.json().catch(() => ({}));
  return res.status(response.ok ? 200 : 500).json({ ok: Boolean(data.ok), result: data.result ?? null, error: data.description ?? null });
}
