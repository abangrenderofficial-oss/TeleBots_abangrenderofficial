const SAFE_WEBHOOK_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram-safe-v2';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'missing_token' });

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: SAFE_WEBHOOK_URL,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || 'Telegram setWebhook failed');

    return res.status(200).json({ ok: true, url: SAFE_WEBHOOK_URL });
  } catch (error) {
    console.error('Webhook repair failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'Webhook repair failed' });
  }
}
