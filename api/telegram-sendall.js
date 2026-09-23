import { waitUntil } from '@vercel/functions';
import { telegram } from '../lib/telegram.js';
import { getQueueItem, getSetting, updateQueueItem } from '../lib/store.js';
import {
  completeBatchIfDone,
  getBatch,
  markBatchItemFailed,
  markBatchItemSent,
  markBatchItemSkipped,
  recordBatchMessage,
  recoverStaleClaims,
  requeueBatchItem,
} from '../lib/explicit-batches.js';
import { claimNextOrderedBatchItem } from '../lib/bot/batch/ordered-claim.js';
import { copyWithTelegramRateLimitRetry } from '../lib/bot/batch/send-executor.js';
import {
  shouldContinueInvocation,
  shouldKickNextWorker,
} from '../lib/bot/batch/send-policy.js';

// Always chain through the stable worker alias. Do not call an implementation
// filename directly; this keeps every invocation on the same production route.
const WORKER_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/send-batch-worker';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const batchId = String(req.body?.batch_id || '');
  const secret = String(req.body?.worker_secret || '');
  if (!batchId || !secret) return res.status(400).json({ ok: false, error: 'missing batch credentials' });

  const initialGate = await readSendGate(batchId);
  const batch = initialGate.batch;
  if (!batch || String(batch.worker_secret || '') !== secret) {
    return res.status(403).json({ ok: false, error: 'invalid batch credentials' });
  }

  if (!initialGate.open) {
    return res.status(200).json({
      ok: true,
      stopped: initialGate.reason === 'batch_not_running',
      paused: initialGate.reason === 'global_pause',
      status: batch.status,
    });
  }

  // Recover only genuinely abandoned claims. Healthy duplicate workers are
  // blocked by the atomic ordered-claim RPC and cannot jump ahead.
  await recoverStaleClaims(batchId).catch(() => {});

  const startedAt = Date.now();
  let processed = 0;

  while (shouldContinueInvocation({ processed, startedAt })) {
    const claim = await claimNextOrderedBatchItem(batchId);
    if (!claim) break;

    const item = await getQueueItem(claim.item_id).catch(() => null);
    if (!item) {
      await markBatchItemSkipped(batchId, claim.position, 'Queue item missing').catch(() => {});
      processed += 1;
      continue;
    }

    const status = String(item.status || '').toUpperCase();
    const eligible = initialGate.batch.mode === 'resend'
      ? ['READY', 'FAILED', 'SENT'].includes(status)
      : ['READY', 'FAILED'].includes(status);

    if (!eligible) {
      await markBatchItemSkipped(batchId, claim.position, `Item status ${status || 'unknown'} not eligible`).catch(() => {});
      processed += 1;
      continue;
    }

    if (status === 'FAILED' && isInvalidTranslationFailure(item.error_message)) {
      await markBatchItemSkipped(
        batchId,
        claim.position,
        'Blocked: recaption translation/validation is not valid yet',
      ).catch(() => {});
      processed += 1;
      continue;
    }

    // Hard gate immediately before Telegram. /stop may arrive while an item is
    // being prepared, but no NEXT copyMessage starts after this gate observes it.
    const finalGate = await readSendGate(batchId);
    if (!finalGate.open) {
      await requeueBatchItem(batchId, claim.position).catch(() => {});
      break;
    }

    const activeBatch = finalGate.batch;
    const forceResend = activeBatch.mode === 'resend' && status === 'SENT';
    const payload = {
      chat_id: activeBatch.destination_chat_id,
      from_chat_id: item.source_chat_id,
      message_id: item.source_message_id,
      parse_mode: 'HTML',
      caption: item.final_caption_html || '',
    };
    if (forceResend) payload.__force_resend = true;

    let sent;
    try {
      sent = await copyWithTelegramRateLimitRetry({
        copy: (copyPayload) => telegram('copyMessage', copyPayload),
        payload,
        onWait: ({ retryAfterMs }) => {
          console.warn(`Telegram rate limit. Waiting ${retryAfterMs}ms before ordered retry.`);
        },
      });
    } catch (error) {
      // Only a genuine Telegram-send failure becomes FAILED. Anything that
      // happens AFTER Telegram returns success must never be treated as unsent,
      // otherwise a retry could create another group message.
      await markBatchItemFailed(batchId, claim.position, error).catch(() => {});
      if (status !== 'SENT') {
        await updateQueueItem(item.id, {
          status: 'FAILED',
          error_message: String(error?.message || error).slice(0, 1000),
        }).catch(() => {});
      }
      processed += 1;
      continue;
    }

    const destinationMessageId = Number(sent?.message_id);
    if (!Number.isInteger(destinationMessageId) || destinationMessageId <= 0) {
      // Telegram claimed success but did not provide a usable message id. Do
      // not auto-retry this item: the external send outcome is ambiguous.
      await markBatchItemSkipped(batchId, claim.position, 'Telegram success without valid destination message ID').catch(() => {});
      await updateQueueItem(item.id, {
        status: 'SENT',
        destination_chat_id: String(activeBatch.destination_chat_id),
        error_message: 'Telegram success without valid destination message ID; manual review required',
      }).catch(() => {});
      processed += 1;
      continue;
    }

    // If Telegram's exact-occurrence dedupe says this message existed BEFORE
    // this explicit batch, never attach that older group message to this batch.
    if (sent?.__deduped) {
      await markBatchItemSkipped(batchId, claim.position, 'Already sent before this explicit batch').catch(() => {});
      await updateQueueItem(item.id, {
        status: 'SENT',
        destination_chat_id: String(activeBatch.destination_chat_id),
        destination_message_id: destinationMessageId,
        error_message: null,
      }).catch(() => {});
      processed += 1;
      continue;
    }

    // Telegram has definitely accepted this NEW message. Persist its exact
    // destination id through two independent batch records. Post-send DB trouble
    // must never turn the item back into FAILED/PENDING.
    const [itemPersist, ledgerPersist] = await Promise.allSettled([
      retryMarkBatchItemSent(batchId, claim.position, destinationMessageId),
      recordBatchMessage({
        batchId,
        item,
        destinationChatId: activeBatch.destination_chat_id,
        destinationMessageId,
      }),
    ]);

    if (itemPersist.status === 'rejected') {
      console.error('Batch SENT item persistence failed after Telegram success:', itemPersist.reason?.message || itemPersist.reason);
    }
    if (ledgerPersist.status === 'rejected') {
      console.error('Batch ledger persistence failed after Telegram success:', ledgerPersist.reason?.message || ledgerPersist.reason);
    }

    await updateQueueItem(item.id, {
      status: 'SENT',
      destination_chat_id: String(activeBatch.destination_chat_id),
      destination_message_id: destinationMessageId,
      sent_at: new Date().toISOString(),
      error_message: (itemPersist.status === 'rejected' && ledgerPersist.status === 'rejected')
        ? 'Sent to Telegram but batch tracking persistence failed; manual review required'
        : null,
    }).catch((error) => {
      console.error('Queue SENT update failed after Telegram success:', error?.message || error);
    });

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
  } else if (latest && shouldKickNextWorker({
    status: latest.status,
    pending: progress.pending,
    sending: progress.sending,
  })) {
    // One continuation only after this invocation owns no in-flight claim.
    // Duplicate workers that observe another SENDING item exit quietly instead
    // of creating a worker fan-out loop.
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

async function readSendGate(batchId) {
  const batch = await getBatch(batchId).catch(() => null);
  if (!batch) return { open: false, reason: 'missing_batch', batch: null };
  if (batch.status !== 'RUNNING') return { open: false, reason: 'batch_not_running', batch };

  const pauseValue = await getSetting(`send_paused:${batch.admin_chat_id}`).catch(() => null);
  if (pauseValue === true || pauseValue?.paused) {
    return { open: false, reason: 'global_pause', batch };
  }
  return { open: true, reason: null, batch };
}

function isInvalidTranslationFailure(value) {
  return /translation unavailable|translate failed|translation still contains non-latin|recaption validation failed/i.test(String(value || ''));
}

async function retryMarkBatchItemSent(batchId, position, destinationMessageId) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const row = await markBatchItemSent(batchId, position, destinationMessageId);
      if (row) return row;
      throw new Error('markBatchItemSent returned no row');
    } catch (error) {
      lastError = error;
      await sleep(100 * (attempt + 1));
    }
  }
  throw lastError || new Error('Unable to persist SENT batch item');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
