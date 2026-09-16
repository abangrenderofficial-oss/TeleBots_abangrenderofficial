import { getSetting, setSetting } from '../../store.js';
import { telegram } from '../../telegram.js';
import { getFormatReview, isFormatPipelinePaused } from './format-gate.js';
import { processPendingItem } from './media.js';
import {
  getRecaptionSession,
  listRecaptionSessionItems,
  setRecaptionSessionStatus,
} from './recaption-collection.js';

export const RECAPTION_WORKER_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/recaption-worker';
export const RECAPTION_MAX_ITEMS_PER_INVOCATION = 8;
export const RECAPTION_MAX_WORK_MS = 12_000;

export async function kickRecaptionWorker(session) {
  if (!session?.id || !session?.worker_secret) throw new Error('Recaption worker credentials tak lengkap');
  const response = await fetch(RECAPTION_WORKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: session.id,
      worker_secret: session.worker_secret,
    }),
  });
  if (!response.ok) throw new Error(`Recaption worker kick HTTP ${response.status}`);
  return response.json().catch(() => ({ ok: true }));
}

export async function runRecaptionSession({ sessionId, workerSecret }) {
  const session = await getRecaptionSession(sessionId);
  if (!session || String(session.worker_secret || '') !== String(workerSecret || '')) {
    return { ok: false, status_code: 403, error: 'invalid session credentials' };
  }

  if (['COMPLETED', 'FAILED'].includes(String(session.status || '').toUpperCase())) {
    return { ok: true, done: true, status: session.status, session };
  }

  if (String(session.status || '').toUpperCase() === 'PAUSED' || await isFormatPipelinePaused(session.admin_chat_id)) {
    if (String(session.status || '').toUpperCase() !== 'PAUSED') {
      await setRecaptionSessionStatus(session.id, 'PAUSED').catch(() => {});
    }
    return { ok: true, paused: true, status: 'PAUSED', session };
  }

  if (String(session.status || '').toUpperCase() !== 'PROCESSING') {
    return { ok: true, stopped: true, status: session.status, session };
  }

  const startedAt = Date.now();
  const pending = await listRecaptionSessionItems(session.admin_chat_id, session.id, ['PENDING'], 1000);
  let processed = 0;
  let paused = false;

  for (const item of pending) {
    if (processed >= RECAPTION_MAX_ITEMS_PER_INVOCATION) break;
    if (Date.now() - startedAt >= RECAPTION_MAX_WORK_MS) break;

    const activeReview = await getFormatReview(session.admin_chat_id);
    if (activeReview?.paused) {
      paused = true;
      break;
    }

    try {
      const result = await processPendingItem(item, {
        resumed: true,
        recaptionSessionId: session.id,
      });
      processed += 1;
      if (result?.paused_new_format) {
        paused = true;
        break;
      }
    } catch (error) {
      processed += 1;
      console.error('Manual recaption item failed:', item.id, error?.message || error);
    }
  }

  if (paused || await isFormatPipelinePaused(session.admin_chat_id)) {
    await setRecaptionSessionStatus(session.id, 'PAUSED').catch(() => {});
    return { ok: true, paused: true, processed, status: 'PAUSED', session_id: session.id };
  }

  const [remaining, failed] = await Promise.all([
    listRecaptionSessionItems(session.admin_chat_id, session.id, ['PENDING'], 1000),
    listRecaptionSessionItems(session.admin_chat_id, session.id, ['FAILED'], 1000),
  ]);

  if (!remaining.length) {
    const finalStatus = failed.length ? 'FAILED' : 'COMPLETED';
    await setRecaptionSessionStatus(session.id, finalStatus);
    if (finalStatus === 'COMPLETED') await releaseOwnedSendGate(session).catch(() => {});

    await telegram('sendMessage', {
      chat_id: session.admin_chat_id,
      text: failed.length
        ? `⚠️ RECAPTION selesai dengan ${failed.length} gagal · ${Math.max(0, Number(session.item_count || 0) - failed.length)} processed. SEND kekal pause kalau format gate tadi yang hentikan.`
        : `✅ RECAPTION selesai · ${session.item_count || 0} item processed.`,
    }).catch(() => {});
    return {
      ok: true,
      done: true,
      processed,
      failed: failed.length,
      status: finalStatus,
      session_id: session.id,
    };
  }

  return {
    ok: true,
    done: false,
    should_continue: true,
    processed,
    remaining: remaining.length,
    status: 'PROCESSING',
    session_id: session.id,
    worker_secret: session.worker_secret,
  };
}

async function releaseOwnedSendGate(session) {
  const key = `send_paused:${session.admin_chat_id}`;
  const gate = await getSetting(key).catch(() => null);
  if (!gate?.paused) return false;
  if (String(gate.reason || '') !== 'new_format_review') return false;
  if (String(gate.recaption_session_id || '') !== String(session.id)) return false;

  await setSetting(key, {
    paused: false,
    hard_stop: false,
    reason: 'recaption_completed',
    recaption_session_id: session.id,
    resumed_at: new Date().toISOString(),
  });
  return true;
}
