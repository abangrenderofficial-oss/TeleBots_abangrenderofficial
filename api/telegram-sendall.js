import { waitUntil } from '@vercel/functions';
import { telegram } from '../lib/telegram.js';
import { getQueueItem, getSetting, updateQueueItem } from '../lib/store.js';
import {
  claimNextBatchItem,
  completeBatchIfDone,
  getBatch,
  markBatchItemFailed,
  markBatchItemSent,
  markBatchItemSkipped,
  recordBatchMessage,
  recoverStaleClaims,
  requeueBatchItem,
} from '../lib/explicit-batches.js';

const WORKER_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram-sendall';
const CHUNK_SIZE = 3;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const batchId = String(req.body?.batch_id || '');
  const secret = String(req.body?.worker_secret || '');
  if (!batchId || !secret) return res.status(400).json({ ok: false, error: 'missing batch credentials' });

  const batch = await getBatch(batchId).catch(() => null);
  if (!batch || String(batch.worker_secret || '') !== secret) {
    return res.status(403).json({ ok: false, error: 'invalid batch credentials' });
  }

  if (batch.status !== 'RUNNING') {
    return res.status(200).json({ ok: true, stopped: true, status: batch.status });
  }

  if (await isPaused(batch.admin_chat_id)) {
    return res.status(200).json({ ok: true, paused: true });
  }

  await recoverStaleClaims(batchId).catch(() => {});

  let processed = 0;
  while (processed < CHUNK_SIZE) {
    const current = await getBatch(batchId).catch(() => null);
    if (!current || current.status !== 'RUNNING' || await isPaused(current.admin_chat_id)) break;

    const claim = await claimNextBatchItem(batchId);
    if (!claim) break;

    const item = await getQueueItem(claim.item_id).catch(() => null);
    if (!item) {
      await markBatchItemSkipped(batchId, claim.position, 'Queue item missing').catch(() => {});
      processed += 1;
      continue;
    }

    const status = String(item.status || '').toUpperCase();
    const eligible = current.mode === 'resend'
      ? ['READY', 'FAILED', 'SENT'].includes(status)
      : ['READY', 'FAILED'].includes(status);

    if (!eligible) {
      await markBatchItemSkipped(batchId, claim.position, `Item status ${status || 'unknown'} not eligible`).catch(() => {});
      processed += 1;
      continue;
    }

    // HARD GATE immediately before Telegram. /stop only needs to flip the DB
    // state; any already-running worker is blocked before its next copyMessage.
    const gateBatch = await getBatch(batchId).catch(() => null);
    if (!gateBatch || gateBatch.status !== 'RUNNING' || await isPaused(gateBatch.admin_chat_id)) {
      await requeueBatchItem(batchId, claim.position).catch(() => {});
      break;
    }

    try {
      const forceResend = current.mode === 'resend' && status === 'SENT';
      const payload = {
        chat_id: current.destination_chat_id,
        from_chat_id: item.source_chat_id,
        message_id: item.source_message_id,
        parse_mode: 'HTML',
        caption: item.final_caption_html || '',
      };
      if (forceResend) payload.__force_resend = true;

      const sent = await telegram('copyMessage', payload);
      const destinationMessageId = Number(sent?.message_id);
      if (!Number.isInteger(destinationMessageId) || destinationMessageId <= 0) {
        throw new Error('Telegram returned invalid destination message ID');
      }

      await markBatchItemSent(batchId, claim.position, destinationMessageId);

      await recordBatchMessage({
        batchId,
        item,
        destinationChatId: current.destination_chat_id,
        destinationMessageId,
      }).catch((error) => {
        console.error('Batch ledger insert failed after Telegram send:', error?.message || error);
      });

      await updateQueueItem(item.id, {
        status: 'SENT',
        destination_chat_id: String(current.destination_chat_id),
        destination_message_id: destinationMessageId,
        sent_at: new Date().toISOString(),
        error_message: null,
      }).catch((error) => {
        console.error('Queue SENT update failed:', error?.message || error);
      });
    } catch (error) {
      await markBatchItemFailed(batchId, claim.position, error).catch(() => {});
      if (status !== 'SENT') {
        await updateQueueItem(item.id, {
          status: 'FAILED',
          error_message: String(error?.message || error).slice(0, 1000),
        }).catch(() => {});
      }
    }

    processed += 1;
  }

  const progress = await completeBatchIfDone(batchId);
  const latest = progress.batch || await getBatch(batchId).catch(() => null);

  if (progress.transitioned && latest) {
    const failedText = progress.failed ? ` · ${progress.failed} failed` : '';
    await telegram('sendMessage', {
      chat_id: latest.admin_chat_id,
      text: `✅ BATCH ${latest.id} selesai · ${progress.sent} sent${failedText}`,
      reply_markup: {
        inline_keyboard: [[
          { text: '🗑 RESET THIS BATCH', callback_data: `reset_exact:${latest.id}` },
        ]],
      },
    }).catch(() => {});
  } else if (latest?.status === 'RUNNING' && progress.pending > 0) {
    waitUntil(kickWorker(latest).catch((error) => {
      console.error('Next batch worker kick failed:', error?.message || error);
    }));
  }

  return res.status(200).json({
    ok: true,
    batch_id: batchId,
    processed,
    status: latest?.status || null,
    sent: progress.sent,
    failed: progress.failed,
    pending: progress.pending,
    sending: progress.sending,
  });
}

async function isPaused(chatId) {
  const value = await getSetting(`send_paused:${chatId}`).catch(() => null);
  return Boolean(value === true || value?.paused);
}

async function kickWorker(batch) {
  const response = await fetch(WORKER_URL, {
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
