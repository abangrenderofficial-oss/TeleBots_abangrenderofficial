const SAFE_WEBHOOK_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram-safe-destination';
const SMOKE_CHAT_ID = '-5438007168';
const SMOKE_MESSAGE_IDS = [2005, 2006, 2007];

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

    const cleanupResponse = await fetch(`https://api.telegram.org/bot${token}/deleteMessages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: SMOKE_CHAT_ID,
        message_ids: SMOKE_MESSAGE_IDS,
      }),
    });
    const cleanupData = await cleanupResponse.json().catch(() => ({}));
    const smoke_cleanup = {
      ok: Boolean(cleanupResponse.ok && cleanupData.ok && cleanupData.result === true),
      description: cleanupData.description || null,
      chat_id: SMOKE_CHAT_ID,
      message_ids: SMOKE_MESSAGE_IDS,
    };

    return res.status(200).json({ ok: true, url: SAFE_WEBHOOK_URL, info, smoke_cleanup });
  } catch (error) {
    console.error('Webhook repair failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'Webhook repair failed' });
  }
}
