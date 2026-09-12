export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'missing_token' });
  const url = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram-safe-destination';
  const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false }),
  });
  const data = await r.json().catch(() => ({}));
  return res.status(data.ok ? 200 : 500).json({ ok: Boolean(data.ok), url, error: data.description || null });
}
