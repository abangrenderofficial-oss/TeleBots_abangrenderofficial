import QRCode from 'qrcode';
import safeDestination from './telegram-safe-destination.js';
import { getTelegramQrDisplay } from '../lib/bot/features/telegram-account.js';

export default async function handler(req, res) {
  const qrKey = typeof req.query?.qr === 'string' ? req.query.qr : '';

  if (req.method === 'GET' && qrKey) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
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

  // Compatibility alias: all ordinary Telegram traffic still uses the same
  // isolated safe-destination router.
  return safeDestination(req, res);
}
