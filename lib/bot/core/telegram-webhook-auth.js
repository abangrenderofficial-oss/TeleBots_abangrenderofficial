import { createHash, timingSafeEqual } from 'node:crypto';

const HEADER = 'x-telegram-bot-api-secret-token';

export function telegramWebhookSecret(token = process.env.TELEGRAM_BOT_TOKEN) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return createHash('sha256').update('telegram-webhook:v1:').update(token).digest('hex');
}

export function isAuthorizedTelegramWebhook(req) {
  let expected;
  try {
    expected = telegramWebhookSecret();
  } catch {
    return false;
  }

  const supplied = req?.headers?.[HEADER];
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function rejectUnauthorizedTelegramWebhook(req, res) {
  if (isAuthorizedTelegramWebhook(req)) return false;
  res.status(401).json({ ok: false, error: 'Unauthorized webhook' });
  return true;
}
