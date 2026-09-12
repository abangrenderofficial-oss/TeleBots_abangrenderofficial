import { waitUntil } from '@vercel/functions';
import {
  getLatestBatch,
  resumeBatch,
  stopAllRunningBatches,
} from '../../explicit-batches.js';
import { getSetting, setSetting } from '../../store.js';
import { answerCallback, rawBot, sendText } from '../core/telegram-client.js';
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
      ? `⛔ HARD STOP\n${stopped.length} batch running dihentikan. Latest ${latest?.id || ''}: ${sent} sent · ${remaining} remaining.`
      : '⛔ HARD STOP\nSemua SEND baru ditahan. Tak ada batch explicit yang sedang berjalan.',
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

  await setSetting(`send_paused:${chatId}`, {
    paused: false,
    hard_stop: false,
    resumed_at: new Date().toISOString(),
  });

  const latest = await getLatestBatch(chatId).catch(() => null);
  if (latest?.status === 'STOPPED') {
    const resumed = await resumeBatch(latest.id);
    if (resumed?.status === 'RUNNING') {
      await sendText(chatId, `▶️ Batch ${resumed.id} sambung.`);
      waitUntil(kickWorker(resumed).catch((error) => {
        console.error('Resume worker kick failed:', error?.message || error);
      }));
      return res.status(200).json({ ok: true, resumed: true, batch_id: resumed.id });
    }
  }

  // New router never restarts a legacy loop. It only clears the global gate.
  // Any historical legacy batch remains stopped; this prevents old workers from
  // silently reappearing after the architecture migration.
  await sendText(chatId, '▶️ SEND aktif semula. Tak ada explicit batch tergantung untuk disambung.');
  return res.status(200).json({ ok: true, resumed: false });
}
