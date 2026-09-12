export const MAX_ITEMS_PER_INVOCATION = 12;
export const MAX_WORK_MS = 12_000;
export const MAX_RATE_LIMIT_RETRIES = 4;

export function shouldContinueInvocation({ processed, startedAt, now = Date.now() }) {
  return Number(processed || 0) < MAX_ITEMS_PER_INVOCATION
    && Number(now) - Number(startedAt || 0) < MAX_WORK_MS;
}

export function parseTelegramRetryAfterMs(error) {
  const message = String(error?.message || error || '');
  const match = message.match(/retry\s+after\s+(\d+)/i);
  if (!match) return null;

  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  // Telegram explicitly rejected this send and told us when to retry. Add a
  // small safety margin so the retry does not land on the same rate-limit edge.
  return (seconds * 1000) + 250;
}

export function shouldKickNextWorker({ status, pending, sending }) {
  return String(status || '') === 'RUNNING'
    && Number(pending || 0) > 0
    && Number(sending || 0) === 0;
}
