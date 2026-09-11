export const SENDALL_WORKER_VERSION = 'sendall_v3';
const STABLE_WORKER_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram-sendall';

export async function triggerSendAllWorker({ chatId, batchId, workerToken }) {
  if (!chatId || !batchId || !workerToken) throw new Error('Invalid SEND ALL worker trigger');

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(STABLE_WORKER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          __sendall_worker: true,
          chat_id: String(chatId),
          batch_id: String(batchId),
          worker_token: String(workerToken),
        }),
      });

      if (!response.ok) throw new Error(`SEND ALL worker HTTP ${response.status}`);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(350 * (attempt + 1));
    }
  }

  throw lastError || new Error('Unable to trigger SEND ALL worker');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
