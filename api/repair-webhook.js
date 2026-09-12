import { repairTelegramWebhook } from '../lib/telegram.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  try {
    // Single source of truth for the Telegram webhook target.
    // This avoids repair-webhook drifting to an old/deleted endpoint.
    const result = await repairTelegramWebhook();
    return res.status(200).json(result);
  } catch (error) {
    console.error('Webhook repair failed:', error?.message || error);
    return res.status(500).json({
      ok: false,
      error: String(error?.message || error).slice(0, 500),
    });
  }
}
