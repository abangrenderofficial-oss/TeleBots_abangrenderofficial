import { waitUntil } from '@vercel/functions';
import {
  kickRecaptionWorker,
  runRecaptionSession,
} from '../lib/bot/features/recaption-runner.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const sessionId = String(req.body?.session_id || '');
  const workerSecret = String(req.body?.worker_secret || '');
  if (!sessionId || !workerSecret) {
    return res.status(400).json({ ok: false, error: 'missing session credentials' });
  }

  const result = await runRecaptionSession({
    sessionId,
    workerSecret,
  });

  if (result.status_code === 403) return res.status(403).json(result);

  if (result.should_continue) {
    waitUntil(kickRecaptionWorker({
      id: sessionId,
      worker_secret: workerSecret,
    }).catch((error) => {
      console.error('Recaption continuation kick failed:', error?.message || error);
    }));
  }

  return res.status(200).json(result);
}
