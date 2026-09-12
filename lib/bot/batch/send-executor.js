import {
  MAX_RATE_LIMIT_RETRIES,
  parseTelegramRetryAfterMs,
} from './send-policy.js';

export async function copyWithTelegramRateLimitRetry({
  copy,
  payload,
  sleepFn = sleep,
  onWait = null,
}) {
  if (typeof copy !== 'function') throw new Error('copy function is required');

  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      return await copy(payload);
    } catch (error) {
      lastError = error;
      const retryAfterMs = parseTelegramRetryAfterMs(error);
      if (retryAfterMs == null || attempt >= MAX_RATE_LIMIT_RETRIES) throw error;

      if (typeof onWait === 'function') {
        await onWait({ attempt: attempt + 1, retryAfterMs, error });
      }
      await sleepFn(retryAfterMs);
    }
  }

  throw lastError || new Error('Telegram copy failed');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
