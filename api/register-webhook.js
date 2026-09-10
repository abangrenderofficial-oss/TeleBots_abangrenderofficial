import { telegram } from '../lib/telegram.js';

export default async function handler(req, res) {
  try {
    if (!process.env.SETUP_SECRET || req.query?.key !== process.env.SETUP_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const url = `${proto}://${host}/api/telegram`;

    const result = await telegram('setWebhook', {
      url,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });

    res.status(200).json({ ok: true, webhook: url, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
