import { getSetting } from '../../store.js';
import { BATCH_WORKER_URL } from '../core/constants.js';

export async function isGloballyPaused(chatId) {
  const value = await getSetting(`send_paused:${chatId}`).catch(() => null);
  return Boolean(value === true || value?.paused);
}

export async function resolveDestination() {
  return await getSetting('destination_chat_id').catch(() => null)
    || process.env.DESTINATION_CHAT_ID
    || null;
}

export async function kickWorker(batch) {
  const response = await fetch(BATCH_WORKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      batch_id: batch.id,
      worker_secret: batch.worker_secret,
    }),
  });
  if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
  return response.json().catch(() => ({}));
}
