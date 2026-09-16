import { waitUntil } from '@vercel/functions';
import { sendText } from '../core/telegram-client.js';
import { getFormatReview } from '../features/format-gate.js';
import {
  closeActiveRecaptionCollection,
  getLatestRecaptionSession,
} from '../features/recaption-collection.js';
import { kickRecaptionWorker } from '../features/recaption-runner.js';

export const names = ['recaption'];

export async function handle({ message, res }) {
  const chatId = message.chat.id;
  const review = await getFormatReview(chatId);
  if (review?.paused) {
    await sendText(
      chatId,
      review.confirmed
        ? '⏸ Format baru dah confirm tapi recaption masih pause. Hantar /resume untuk sambung session tu dulu.'
        : '⏸ Recaption tengah tunggu format baru. Set format dekat preview, confirm dua kali, kemudian /resume.',
    );
    return res.status(200).json({ ok: true, started: false, blocked: 'format_review' });
  }

  const existing = await getLatestRecaptionSession(chatId, ['PROCESSING', 'PAUSED']);
  if (existing) {
    await sendText(
      chatId,
      String(existing.status).toUpperCase() === 'PAUSED'
        ? '⏸ Session recaption sebelumnya masih pause. Confirm format dan guna /resume dulu.'
        : `⏳ RECAPTION masih berjalan · ${existing.item_count || 0} item.`,
    );
    return res.status(200).json({ ok: true, started: false, existing_session: existing.id, status: existing.status });
  }

  const session = await closeActiveRecaptionCollection(chatId);
  if (!session?.id) {
    await sendText(chatId, 'Tak ada forwarded item baru untuk recaption. Forward dulu, lepas tu hantar /recaption.');
    return res.status(200).json({ ok: true, started: false, reason: 'nothing_collected' });
  }

  await sendText(chatId, `▶️ RECAPTION start · ${session.item_count || 0} item yang kau kumpul.`);
  waitUntil(kickRecaptionWorker(session).catch(async (error) => {
    console.error('Initial recaption worker kick failed:', error?.message || error);
    await sendText(chatId, `❌ RECAPTION worker tak dapat start. Session kekal selamat untuk retry. ${String(error?.message || error).slice(0, 220)}`).catch(() => {});
  }));

  return res.status(200).json({
    ok: true,
    started: true,
    session_id: session.id,
    count: session.item_count || 0,
  });
}
