import QRCode from 'qrcode';
import { routeUpdate } from '../lib/bot/update-router.js';
import { rejectUnauthorizedTelegramWebhook } from '../lib/bot/core/telegram-webhook-auth.js';
import { getTelegramQrDisplay } from '../lib/bot/features/telegram-account.js';

const BUILD_MARKER = 'manual-recaption-trigger-v1';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const qrKey = typeof req.query?.key === 'string' ? req.query.key : '';
  if (req.method === 'GET' && qrKey) {
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

    const display = await getTelegramQrDisplay(qrKey).catch(() => null);
    if (!display?.deep_link) return res.status(404).send('QR expired or unavailable');

    try {
      const png = await QRCode.toBuffer(display.deep_link, {
        type: 'png',
        width: 640,
        margin: 3,
        errorCorrectionLevel: 'M',
      });
      res.setHeader('Content-Type', 'image/png');
      return res.status(200).send(png);
    } catch {
      return res.status(500).send('Unable to render QR');
    }
  }

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
