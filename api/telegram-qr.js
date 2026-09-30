import QRCode from 'qrcode';
import { getTelegramQrDisplay } from '../lib/bot/features/telegram-account.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method Not Allowed');
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  const key = typeof req.query?.key === 'string' ? req.query.key : '';
  if (!key) return res.status(400).send('Missing QR key');

  const display = await getTelegramQrDisplay(key).catch(() => null);
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
