import { telegramWebhookSecret } from '../lib/bot/core/telegram-webhook-auth.js';

const SAFE_WEBHOOK_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram-safe-destination';

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
        secret_token: telegramWebhookSecret(token),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || 'Telegram setWebhook failed');

    const infoResponse = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const infoData = await infoResponse.json().catch(() => ({}));
    const info = infoData?.ok ? {
      url: infoData.result?.url || null,
      pending_update_count: infoData.result?.pending_update_count ?? null,
      allowed_updates: infoData.result?.allowed_updates || null,
      last_error_date: infoData.result?.last_error_date || null,
      last_error_message: infoData.result?.last_error_message || null,
    } : null;

    return res.status(200).json({ ok: true, url: SAFE_WEBHOOK_URL, secret_token_configured: true, info });
  } catch (error) {
    console.error('Webhook repair failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'Webhook repair failed' });
  }
}
