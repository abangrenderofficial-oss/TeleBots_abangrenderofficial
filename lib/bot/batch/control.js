import { waitUntil } from '@vercel/functions';
import {
  getLatestBatch,
  resumeBatch,
  stopAllRunningBatches,
} from '../../explicit-batches.js';
import { getSetting, setSetting } from '../../store.js';
import { answerCallback, rawBot, sendText } from '../core/telegram-client.js';
import { kickImmediateMediaWorker } from '../features/immediate-media-worker.js';
import {
  PIPELINE_REASONS,
  getPipelineState,
  resumePipeline,
} from '../features/pipeline-controller.js';
import {
  getLatestRecaptionSession,
  setRecaptionSessionStatus,
} from '../features/recaption-collection.js';
import { kickRecaptionWorker } from '../features/recaption-runner.js';
import { kickWorker } from './shared.js';

export async function hardStop({ chatId, res }) {
  const now = new Date().toISOString();
  await setSetting(`send_paused:${chatId}`, {
    paused: true,
    hard_stop: true,
    paused_at: now,
  });

  const stopped = await stopAllRunningBatches(chatId).catch(() => []);

  // Compatibility only: make sure an old pre-explicit-batch worker also sees STOP.
  const legacy = await getSetting(`active_send_batch:${chatId}`).catch(() => null);
  if (legacy) {
    await setSetting(`active_send_batch:${chatId}`, {
      ...legacy,
      hard_stopped: true,
      hard_stopped_at: now,
      updated_at: now,
    }).catch(() => {});
  }

  const latest = stopped.length
    ? stopped.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
    : await getLatestBatch(chatId).catch(() => null);
  const sent = Number(latest?.sent_count || 0);
  const total = Array.isArray(latest?.item_ids) ? latest.item_ids.length : 0;
  const remaining = Math.max(0, total - Number(latest?.next_index || 0));

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: stopped.length
      ? `⛔ HARD STOP\n${stopped.length} batch running dihentikan. Latest ${latest?.id || ''}: ${sent} sent · ${remaining} remaining.\nPrep/recaption pipeline pun pause.`
      : '⛔ HARD STOP\nSemua SEND baru + prep/recaption pipeline ditahan.',
    reply_markup: {
      inline_keyboard: [[
        { text: '▶️ RESUME', callback_data: 'hard_resume' },
        latest?.id
          ? { text: '🗑 RESET BATCH', callback_data: `reset_exact:${latest.id}` }
          : { text: '🗑 RESET BATCH', callback_data: 'resetbatch_confirm' },
      ]],
    },
  });

  return res.status(200).json({ ok: true, hard_stopped: true, stopped_batches: stopped.length });
}

export async function resumeLatest({ chatId, query = null, res }) {
  if (query?.id) await answerCallback(query.id).catch(() => {});

  // The inline RESUME button must never bypass a format or AI safety gate.
  const formatReview = await getSetting(`format_review_gate:${chatId}`).catch(() => null);
  if (formatReview?.paused) {
    await sendText(
      chatId,
      formatReview.confirmed
        ? '⏸ Format dah confirm, tapi caption queue belum disambung. Guna /resume supaya queue diproses dulu sebelum SEND aktif.'
        : '⛔ Format baru belum double-confirm. Set format dekat preview dan confirm dua kali dulu.',
    );
    return res.status(200).json({
      ok: true,
      resumed: false,
      blocked: formatReview.confirmed ? 'format_queue_pending' : 'format_not_confirmed',
    });
  }

  const pipeline = await getPipelineState(chatId);
  if (pipeline?.reason === PIPELINE_REASONS.AI_LIMIT) {
    await sendText(chatId, '⏸ AI wait masih aktif. Guna button TERUSKAN TANPA AI pada warning itu, atau tunggu AI available.');
    return res.status(200).json({ ok: true, resumed: false, blocked: 'ai_limit' });
  }

  if (pipeline?.reason === PIPELINE_REASONS.MANUAL_STOP) {
    await resumePipeline(chatId, { allowedReasons: [PIPELINE_REASONS.MANUAL_STOP] });
    const pausedSession = await getLatestRecaptionSession(chatId, ['PAUSED']).catch(() => null);
    if (pausedSession?.id) {
      const runnable = await setRecaptionSessionStatus(pausedSession.id, 'PROCESSING');
      waitUntil(kickRecaptionWorker(runnable || pausedSession).catch((error) => {
        console.error('Inline unified recaption resume failed:', error?.message || error);
      }));
    }
    waitUntil(kickImmediateMediaWorker(chatId).catch((error) => {
      console.error('Inline unified immediate resume failed:', error?.message || error);
    }));
  }

  await setSetting(`send_paused:${chatId}`, {
    paused: false,
    hard_stop: false,
    resumed_at: new Date().toISOString(),
  });

  const latest = await getLatestBatch(chatId).catch(() => null);
  if (latest?.status === 'STOPPED') {
    const resumed = await resumeBatch(latest.id);
    if (resumed?.status === 'RUNNING') {
      await sendText(chatId, `▶️ Batch ${resumed.id} sambung. Prep/recaption pipeline aktif semula.`);
      waitUntil(kickWorker(resumed).catch((error) => {
        console.error('Resume worker kick failed:', error?.message || error);
      }));
      return res.status(200).json({ ok: true, resumed: true, batch_id: resumed.id });
    }
  }

  await sendText(chatId, '▶️ Pipeline + SEND aktif semula. Tak ada explicit batch tergantung untuk disambung.');
  return res.status(200).json({ ok: true, resumed: Boolean(pipeline?.reason === PIPELINE_REASONS.MANUAL_STOP) });
}
