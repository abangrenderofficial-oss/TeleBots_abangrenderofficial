import { waitUntil } from '@vercel/functions';
import { resumeLatest } from '../batch/control.js';
import {
  getFormatReview,
  releaseConfirmedFormatReview,
  restoreFormatReview,
} from '../features/format-gate.js';
import { resumeFormatQueue } from '../features/format-resume.js';
import {
  getRecaptionSession,
  setRecaptionSessionStatus,
} from '../features/recaption-collection.js';
import { kickRecaptionWorker } from '../features/recaption-runner.js';
import { kickImmediateMediaWorker } from '../features/immediate-media-worker.js';
import { sendText } from '../core/telegram-client.js';
import { getSetting } from '../../store.js';

export const names = ['resume'];

export async function handle({ message, res }) {
  const chatId = message.chat.id;
  const review = await getFormatReview(chatId);

  if (review && !review.confirmed) {
    await sendText(chatId, '⛔ Format baru belum double-confirm. Set format dekat preview dan tekan CONFIRM dua kali dulu.');
    return res.status(200).json({
      ok: true,
      resumed: false,
      blocked: 'format_not_confirmed',
      item_id: review.item_id,
      profile_id: review.profile_id,
    });
  }

  // Manual /recaption sessions own their exact collected item set. After the
  // owner confirms a new format, resume that exact session in the bounded
  // recaption worker rather than scanning historical PENDING rows.
  if (review?.confirmed && review.recaption_session_id) {
    const session = await getRecaptionSession(review.recaption_session_id);
    if (!session || String(session.admin_chat_id) !== String(chatId)) {
      await sendText(chatId, '❌ Session recaption untuk format ni tak jumpa. SEND kekal pause.');
      return res.status(200).json({ ok: true, resumed: false, error: 'recaption_session_missing' });
    }

    await releaseConfirmedFormatReview(chatId);
    const resumed = await setRecaptionSessionStatus(session.id, 'PROCESSING');
    await sendText(chatId, `▶️ RECAPTION sambung · session ${session.id.slice(0, 8)}.`);
    waitUntil(kickRecaptionWorker(resumed || session).catch(async (error) => {
      console.error('Resume recaption worker kick failed:', error?.message || error);
      await setRecaptionSessionStatus(session.id, 'PAUSED').catch(() => {});
      await restoreFormatReview(chatId, review).catch(() => {});
      await sendText(chatId, '❌ RECAPTION gagal sambung. Aku kekalkan pause supaya tak lompat item.').catch(() => {});
    }));

    return res.status(200).json({
      ok: true,
      resumed: true,
      recaption_session_id: session.id,
    });
  }

  // New direct-upload queue: after format confirmation, return to the same
  // leased three-way worker instead of the legacy sequential queue drain.
  if (review?.confirmed && !review.recaption_session_id) {
    const floor = await getSetting(`immediate_media_queue_floor:${chatId}`).catch(() => null);
    const floorAt = Date.parse(floor?.at || floor || 0);
    const reviewAt = Date.parse(review.queue_start_created_at || review.created_at || 0);
    const belongsToImmediateQueue = Number.isFinite(floorAt)
      && Number.isFinite(reviewAt)
      && reviewAt >= floorAt;

    if (belongsToImmediateQueue) {
      await releaseConfirmedFormatReview(chatId);
      await sendText(chatId, '▶️ Caption queue sambung semula · worker 3-serentak aktif.');
      waitUntil(kickImmediateMediaWorker(chatId).catch(async (error) => {
        console.error('Resume immediate media worker kick failed:', error?.message || error);
        await restoreFormatReview(chatId, review).catch(() => {});
        await sendText(chatId, '❌ Queue gagal sambung. Aku restore format pause supaya item tak lompat.').catch(() => {});
      }));
      return res.status(200).json({
        ok: true,
        resumed: true,
        immediate_media: true,
      });
    }
  }

  if (review?.confirmed) {
    await releaseConfirmedFormatReview(chatId);

    try {
      let totalProcessed = 0;
      let result = null;
      for (let pass = 0; pass < 5; pass += 1) {
        result = await resumeFormatQueue(chatId, review, { limit: 40 });
        totalProcessed += Number(result?.processed || 0);
        if (result?.paused_again || Number(result?.remaining || 0) === 0) break;
      }

      if (result?.paused_again) {
        await sendText(
          chatId,
          `⏸ ${totalProcessed} queued item dah diproses, tapi format baru lain pula detect. Aku pause balik. Confirm format baru tu dulu.`,
        );
        return res.status(200).json({
          ok: true,
          resumed: false,
          format_paused_again: true,
          processed: totalProcessed,
        });
      }

      if (Number(result?.remaining || 0) > 0) {
        await restoreFormatReview(chatId, {
          ...review,
          confirmed: true,
          oversized_backlog: true,
        });
        await sendText(
          chatId,
          `⏸ ${totalProcessed} queued item dah diproses. Backlog masih besar, jadi SEND kekal pause. Guna /resume sekali lagi untuk sambung baki dengan selamat.`,
        );
        return res.status(200).json({
          ok: true,
          resumed: false,
          processed: totalProcessed,
          remaining: Number(result.remaining),
        });
      }

      if (totalProcessed) {
        await sendText(chatId, `✅ Caption queue sambung semula · ${totalProcessed} item diproses ikut format confirmed.`);
      }
    } catch (error) {
      await restoreFormatReview(chatId, review).catch(() => {});
      await sendText(chatId, `❌ Resume caption queue gagal, jadi SEND aku kekalkan pause. ${String(error?.message || error).slice(0, 300)}`);
      return res.status(200).json({ ok: true, resumed: false, error: 'caption_resume_failed' });
    }
  }

  return resumeLatest({ chatId, res });
}
