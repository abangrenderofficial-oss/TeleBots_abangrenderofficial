import { resumeLatest } from '../batch/control.js';
import {
  getFormatReview,
  releaseConfirmedFormatReview,
  restoreFormatReview,
} from '../features/format-gate.js';
import { resumePendingMedia } from '../features/media.js';
import { sendText } from '../core/telegram-client.js';

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

  if (review?.confirmed) {
    await releaseConfirmedFormatReview(chatId);

    try {
      let totalProcessed = 0;
      let result = null;
      for (let pass = 0; pass < 5; pass += 1) {
        result = await resumePendingMedia(chatId, { limit: 40 });
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
        // Keep SEND paused rather than silently unpausing while caption backlog
        // still exists. This only happens for an unusually large >200 backlog.
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
