import { routeUpdate } from '../lib/bot/update-router.js';
import { rejectUnauthorizedTelegramWebhook } from '../lib/bot/core/telegram-webhook-auth.js';

const BUILD_MARKER = 'manual-recaption-trigger-v1';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      router: 'isolated-router-v1',
      build: BUILD_MARKER,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    });
  }

  if (rejectUnauthorizedTelegramWebhook(req, res)) return;

  try {
    return await routeUpdate(req, res);
  } catch (error) {
    console.error('Isolated Telegram router error:', error);
    return res.status(200).json({
      ok: true,
      handled: false,
      router: 'isolated-router-v1',
      build: BUILD_MARKER,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
      error: String(error?.message || error).slice(0, 500),
    });
  }
}
