import { randomUUID } from 'node:crypto';
import { getProfileForItem } from '../../format-profiles.js';
import { getQueueItem, getSetting, setSetting, updateQueueItem } from '../../store.js';
import { telegram, inlineKeyboard } from '../../telegram.js';
import { getFormatReview, isFormatPipelinePaused } from './format-gate.js';
import { processPendingItem } from './media.js';
import { compactPreviewRows } from './preview-ui.js';
import { recaptionItemWithProfile } from './recaption.js';
import {
  claimRecaptionWorker,
  listRecaptionSessionItems,
  releaseRecaptionWorker,
  setRecaptionSessionStatus,
} from './recaption-collection.js';

export const RECAPTION_WORKER_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/recaption-worker';
export const RECAPTION_MAX_ITEMS_PER_INVOCATION = 8;
export const RECAPTION_MAX_WORK_MS = 12_000;

export function shouldPersistRecaptionPause({ reviewStillActive }) {
  return Boolean(reviewStillActive);
}

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
  const leaseToken = randomUUID();
  const claim = await claimRecaptionWorker(sessionId, workerSecret, leaseToken);
  if (!claim?.claimed) {
    if (claim?.reason === 'invalid_credentials') {
      return { ok: false, status_code: 403, error: 'invalid session credentials' };
    }
    return {
      ok: true,
      claimed: false,
      busy: claim?.reason === 'busy',
      stopped: claim?.reason === 'not_processing',
      status: claim?.status || null,
      reason: claim?.reason || 'not_claimed',
    };
  }

  const session = claim.session;
  try {
    if (await isFormatPipelinePaused(session.admin_chat_id)) {
      await setRecaptionSessionStatus(session.id, 'PAUSED').catch(() => {});
      return { ok: true, paused: true, status: 'PAUSED', session_id: session.id };
    }

    const startedAt = Date.now();
    const pending = await listRecaptionSessionItems(session.admin_chat_id, session.id, ['PENDING'], 1000);
    let processed = 0;
    let pauseObserved = false;

    for (const item of pending) {
      if (processed >= RECAPTION_MAX_ITEMS_PER_INVOCATION) break;
      if (Date.now() - startedAt >= RECAPTION_MAX_WORK_MS) break;

      const activeReview = await getFormatReview(session.admin_chat_id);
      if (activeReview?.paused) {
        pauseObserved = true;
        break;
      }

      try {
        const result = await processPendingItem(item, {
          resumed: true,
          recaptionSessionId: session.id,
        });
        processed += 1;

        if (result?.paused_new_format) {
          pauseObserved = true;
          break;
        }

        if (result?.ready) {
          await finalizeTranslatedRecaptionItem(item.id, session.admin_chat_id);
        }
      } catch (error) {
        processed += 1;
        const errorText = String(error?.message || error).slice(0, 1000);
        await updateQueueItem(item.id, {
          status: 'FAILED',
          error_message: errorText,
        }).catch(() => {});
        console.error('Manual recaption item failed:', item.id, errorText);
      }
    }

    // A very fast owner can double-confirm and /resume while the worker that
    // detected the new format is still unwinding. Re-check the durable review
    // gate now. If /resume already released it, DO NOT write PAUSED again.
    const reviewStillActive = await isFormatPipelinePaused(session.admin_chat_id);
    if (shouldPersistRecaptionPause({ pauseObserved, reviewStillActive })) {
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
          ? `⚠️ RECAPTION selesai dengan ${failed.length} gagal · ${Math.max(0, Number(session.item_count || 0) - failed.length)} processed. Item translation yang tak valid kekal FAILED dan tak dianggap siap.`
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
      pause_observed: pauseObserved,
      processed,
      remaining: remaining.length,
      status: 'PROCESSING',
      session_id: session.id,
      worker_secret: session.worker_secret,
    };
  } finally {
    await releaseRecaptionWorker(session.id, workerSecret, leaseToken).catch((error) => {
      console.error('Recaption worker lease release failed:', error?.message || error);
    });
  }
}

async function finalizeTranslatedRecaptionItem(itemId, chatId) {
  const item = await getQueueItem(itemId);
  if (!item) throw new Error('Recaption item hilang masa final validation');

  const profile = await getProfileForItem(item);
  if (!profile?.actions?.translate) return item;

  const result = await recaptionItemWithProfile(item.id, profile, {
    reason: 'recaption_final_translation_validation',
    syncSent: false,
  });
  const updated = result.item;

  if (updated?.preview_message_id) {
    await telegram('editMessageCaption', {
      chat_id: chatId,
      message_id: updated.preview_message_id,
      caption: updated.final_caption_html || '',
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard(compactPreviewRows(updated.id)),
    }).catch((error) => {
      console.error('Recaption final preview sync failed:', error?.message || error);
    });
  }

  return updated;
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
