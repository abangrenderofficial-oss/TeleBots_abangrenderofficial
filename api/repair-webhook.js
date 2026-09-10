import { repairTelegramWebhook } from '../lib/telegram.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  try {
    const result = await repairTelegramWebhook();
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('Webhook repair failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'Webhook repair failed' });
  }
}
