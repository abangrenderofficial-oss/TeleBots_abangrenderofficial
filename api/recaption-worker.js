import { waitUntil } from '@vercel/functions';
import {
  kickFormatBatchApply,
  runFormatBatchApplyJob,
} from '../lib/bot/features/format-batch-apply.js';
import {
  kickImmediateMediaWorker,
  runImmediateMediaQueue,
} from '../lib/bot/features/immediate-media-worker.js';
import {
  kickRecaptionWorker,
  runRecaptionSession,
} from '../lib/bot/features/recaption-runner.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const mode = String(req.body?.mode || '');
  const workerSecret = String(req.body?.worker_secret || '');

  if (mode === 'immediate_media') {
    const chatId = String(req.body?.chat_id || '');
    if (!chatId || !workerSecret) {
      return res.status(400).json({ ok: false, error: 'missing immediate media credentials' });
    }

    const result = await runImmediateMediaQueue({ chatId, workerSecret });
    if (result.status_code === 403) return res.status(403).json(result);

    if (result.should_continue) {
      waitUntil(kickImmediateMediaWorker(chatId).catch((error) => {
        console.error('Immediate media continuation kick failed:', error?.message || error);
      }));
    }

    return res.status(200).json(result);
  }

  const sessionId = String(req.body?.session_id || '');
  if (!sessionId || !workerSecret) {
    return res.status(400).json({ ok: false, error: 'missing session credentials' });
  }

  if (mode === 'apply_profile') {
    const jobId = String(req.body?.job_id || '');
    if (!jobId) return res.status(400).json({ ok: false, error: 'missing format batch job id' });

    const result = await runFormatBatchApplyJob({
      sessionId,
      workerSecret,
      jobId,
    });

    if (result.status_code === 403) return res.status(403).json(result);
    if (result.status_code === 404) return res.status(404).json(result);

    if (result.should_continue) {
      waitUntil(kickFormatBatchApply({
        sessionId,
        workerSecret,
        jobId,
      }).catch((error) => {
        console.error('Format batch continuation kick failed:', error?.message || error);
      }));
    }

    return res.status(200).json(result);
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
