import { waitUntil } from '@vercel/functions';
import { buildResendBatchItems } from '../../send-control.js';
import { listQueueItems } from '../../store.js';
import {
  createExplicitBatch,
  getRunningBatch,
} from '../../explicit-batches.js';
import { answerCallback, sendText } from '../core/telegram-client.js';
import { isGloballyPaused, kickWorker, resolveDestination } from './shared.js';

export async function startNormalBatch({ chatId, query, res }) {
  await answerCallback(query.id).catch(() => {});

  if (await isGloballyPaused(chatId)) {
    await sendText(chatId, '⛔ SEND masih STOP. Guna /resume dulu.');
    return res.status(200).json({ ok: true, blocked: 'paused' });
  }

  const running = await getRunningBatch(chatId).catch(() => null);
  if (running) {
    await sendText(chatId, `⏳ Batch ${running.id} masih berjalan. Tunggu siap atau guna /stop dulu.`);
    return res.status(200).json({ ok: true, blocked: 'batch_running', batch_id: running.id });
  }

  const destination = await resolveDestination();
  if (!destination) {
    await sendText(chatId, 'Destination belum set. Dalam group target, hantar /connect sekali.');
    return res.status(200).json({ ok: true, blocked: 'no_destination' });
  }

  const items = await buildNormalBatchItems(chatId, query.message?.message_id);
  if (!items.length) {
    await sendText(chatId, 'Tak ada item READY/FAILED dari preview ni untuk SEND ALL.');
    return res.status(200).json({ ok: true, blocked: 'no_items' });
  }

  const { batch, created } = await createExplicitBatch({
    adminChatId: chatId,
    triggerId: `callback:${query.id}`,
    mode: 'normal',
    destinationChatId: destination,
    items,
  });

  if (!created) {
    return res.status(200).json({ ok: true, duplicate_callback: true, batch_id: batch.id });
  }

  await sendText(chatId, `🚀 BATCH ${batch.id} mula · ${items.length} item`).catch(() => {});
  waitUntil(kickWorker(batch).catch((error) => {
    console.error('Initial batch worker kick failed:', error?.message || error);
  }));

  return res.status(200).json({ ok: true, batch_id: batch.id, count: items.length });
}

export async function startResendBatch({ chatId, query, anchorItemId, res }) {
  await answerCallback(query.id).catch(() => {});

  if (await isGloballyPaused(chatId)) {
    await sendText(chatId, '⛔ SEND masih STOP. Guna /resume dulu.');
    return res.status(200).json({ ok: true, blocked: 'paused' });
  }

  const running = await getRunningBatch(chatId).catch(() => null);
  if (running) {
    await sendText(chatId, `⏳ Batch ${running.id} masih berjalan. Tunggu siap atau guna /stop dulu.`);
    return res.status(200).json({ ok: true, blocked: 'batch_running', batch_id: running.id });
  }

  const destination = await resolveDestination();
  if (!destination) {
    await sendText(chatId, 'Destination belum set. Dalam group target, hantar /connect sekali.');
    return res.status(200).json({ ok: true, blocked: 'no_destination' });
  }

  const items = (await buildResendBatchItems(chatId, anchorItemId))
    .filter((item) => ['READY', 'FAILED', 'SENT'].includes(String(item.status || '').toUpperCase()));

  if (!items.length) {
    await sendText(chatId, 'Tak ada item untuk RESEND ALL dari sini.');
    return res.status(200).json({ ok: true, blocked: 'no_items' });
  }

  const { batch, created } = await createExplicitBatch({
    adminChatId: chatId,
    triggerId: `callback:${query.id}`,
    mode: 'resend',
    destinationChatId: destination,
    items,
  });

  if (!created) {
    return res.status(200).json({ ok: true, duplicate_callback: true, batch_id: batch.id });
  }

  await sendText(chatId, `🔁 BATCH ${batch.id} mula · ${items.length} item`).catch(() => {});
  waitUntil(kickWorker(batch).catch((error) => {
    console.error('Initial resend batch worker kick failed:', error?.message || error);
  }));

  return res.status(200).json({ ok: true, batch_id: batch.id, count: items.length });
}

async function buildNormalBatchItems(chatId, previewMessageId) {
  const rows = await listQueueItems(chatId, 1000);
  const anchor = (rows || []).find((row) => Number(row.preview_message_id) === Number(previewMessageId));
  if (!anchor) return [];

  return (rows || [])
    .filter((row) => String(row.admin_chat_id) === String(chatId))
    .filter((row) => String(row.source_chat_id) === String(anchor.source_chat_id))
    .filter((row) => Number(row.source_message_id) >= Number(anchor.source_message_id))
    .filter((row) => ['READY', 'FAILED'].includes(String(row.status || '').toUpperCase()))
    .sort((a, b) => {
      const byMessage = Number(a.source_message_id) - Number(b.source_message_id);
      if (Number.isFinite(byMessage) && byMessage !== 0) return byMessage;
      return Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
    });
}
