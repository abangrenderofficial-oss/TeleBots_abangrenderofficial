import { routeUpdate } from '../lib/bot/update-router.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, router: 'isolated-router-v1' });
  }

  try {
    return await routeUpdate(req, res);
  } catch (error) {
    console.error('Isolated Telegram router error:', error);
    return res.status(200).json({
      ok: true,
      handled: false,
      router: 'isolated-router-v1',
      error: String(error?.message || error).slice(0, 500),
    });
  }
}
