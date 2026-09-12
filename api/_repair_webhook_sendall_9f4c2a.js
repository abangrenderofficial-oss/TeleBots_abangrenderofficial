export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'missing_bot_token' });

  const url = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram-sendall';
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      }),
    });
    const data = await response.json();
    return res.status(data?.ok ? 200 : 500).json({
      ok: Boolean(data?.ok),
      url,
      description: data?.description || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error).slice(0, 300) });
  }
}
