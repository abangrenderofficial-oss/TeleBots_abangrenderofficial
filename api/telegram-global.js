import commandHandler from './telegram-command.js';
import { telegram, isAdminMessage } from '../lib/telegram.js';
import {
  getActiveSendBatch,
  isSendPaused,
  pauseSending,
  resumeSending,
} from '../lib/send-control.js';
import { getSetting, setSetting } from '../lib/store.js';
import {
  SENDALL_WORKER_VERSION,
  triggerSendAllWorker,
} from '../lib/sendall-chain.js';

const CAPTION_PAUSE_PREFIX = 'caption_paused:';
const CAPTION_MEDIA_QUEUE_PREFIX = 'caption_media_queue:';
const CAPTION_RECAP_ACTIVE_PREFIX = 'caption_recap_active:';
const GLOBAL_PAUSE_PREFIX = 'global_paused:';

export default async function handler(req, res) {
  if (req.method !== 'POST') return commandHandler(req, res);

  const message = req.body?.message;
  if (
    message?.chat?.type === 'private'
    && isAdminMessage(message)
  ) {
    const text = String(message.text || '').trim().toLowerCase();
    const chatId = message.chat.id;

    if (text === '/stop') return stopAll(chatId, res);
    if (text === '/resume') return resumeAll(chatId, message, res);
  }

  return commandHandler(req, res);
}

async function stopAll(chatId, res) {
  const sendBatch = await pauseSending(chatId).catch(() => null);
  await Promise.all([
    setSetting(`${CAPTION_PAUSE_PREFIX}${chatId}`, {
      paused: true,
      paused_at: new Date().toISOString(),
      reason: 'global_stop',
    }),
    setSetting(`${GLOBAL_PAUSE_PREFIX}${chatId}`, {
      paused: true,
      paused_at: new Date().toISOString(),
    }),
  ]);

  const [captionQueue, recapState] = await Promise.all([
    getSetting(`${CAPTION_MEDIA_QUEUE_PREFIX}${chatId}`).catch(() => null),
    getSetting(`${CAPTION_RECAP_ACTIVE_PREFIX}${chatId}`).catch(() => null),
  ]);

  const sendRemaining = remainingInBatch(sendBatch);
  const captionQueued = Array.isArray(captionQueue) ? captionQueue.length : 0;
  const recapRemaining = recapState
    ? Math.max(0, Number(recapState.total || 0) - Number(recapState.next_index || 0))
    : 0;

  const details = [];
  if (sendRemaining) details.push(`${sendRemaining} baki SEND`);
  if (recapRemaining) details.push(`${recapRemaining} baki RECAPTION`);
  if (captionQueued) details.push(`${captionQueued} media queued`);

  await telegram('sendMessage', {
    chat_id: chatId,
    text: details.length
      ? `⏸ BOT STOP. Semua aktiviti kerja dibekukan dulu (${details.join(' · ')}). Kau boleh betulkan code, caption atau setting. Bila siap, hantar /resume — bot sambung guna versi paling latest.`
      : '⏸ BOT STOP. Semua aktiviti SEND dan caption/recaption dibekukan dulu. Kau boleh buat pembetulan. Bila siap, hantar /resume.',
  });

  return res.status(200).json({
    ok: true,
    global_paused: true,
    send_remaining: sendRemaining,
    recap_remaining: recapRemaining,
    caption_queued: captionQueued,
  });
}

async function resumeAll(chatId, originalMessage, res) {
  await setSetting(`${GLOBAL_PAUSE_PREFIX}${chatId}`, {
    paused: false,
    resumed_at: new Date().toISOString(),
  });

  const [captionQueue, recapState, sendBatch, sendPaused] = await Promise.all([
    getSetting(`${CAPTION_MEDIA_QUEUE_PREFIX}${chatId}`).catch(() => null),
    getSetting(`${CAPTION_RECAP_ACTIVE_PREFIX}${chatId}`).catch(() => null),
    getActiveSendBatch(chatId).catch(() => null),
    isSendPaused(chatId).catch(() => false),
  ]);

  const hasCaptionWork = Boolean(
    (Array.isArray(captionQueue) && captionQueue.length)
    || (recapState && Math.max(0, Number(recapState.total || 0) - Number(recapState.next_index || 0)) > 0)
  );
  const sendRemaining = remainingInBatch(sendBatch);
  const hasSendWork = sendRemaining > 0;

  // Caption/recaption resumes FIRST so any changed code, tick button or format
  // is applied before a paused SEND batch continues to the destination group.
  if (hasCaptionWork) {
    await replayControlCommand(originalMessage, '/resumecaption').catch((error) => {
      console.error('Global resume caption failed:', error?.message || error);
    });
  } else {
    await setSetting(`${CAPTION_PAUSE_PREFIX}${chatId}`, {
      paused: false,
      resumed_at: new Date().toISOString(),
      reason: 'global_resume',
    });
  }

  if (hasSendWork) {
    if (
      sendBatch?.worker === SENDALL_WORKER_VERSION
      && sendBatch?.id
      && sendBatch?.worker_token
    ) {
      await resumeSending(chatId).catch(() => {});
      await triggerSendAllWorker({
        chatId,
        batchId: sendBatch.id,
        workerToken: sendBatch.worker_token,
      }).catch((error) => {
        console.error('Global resume chained SEND ALL failed:', error?.message || error);
      });
    } else {
      await replayControlCommand(originalMessage, '/resumesend').catch((error) => {
        console.error('Global resume send failed:', error?.message || error);
      });
    }
  } else if (sendPaused) {
    await resumeSending(chatId).catch(() => {});
  }

  if (!hasCaptionWork && !hasSendWork) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: '▶️ BOT RESUME. Semua aktiviti aktif semula. Tak ada batch tergantung untuk disambung.',
    });
  } else {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: '▶️ BOT RESUME. Aktiviti tergendala disambung semula menggunakan code, caption dan setting/tick yang paling latest.',
    });
  }

  return res.status(200).json({
    ok: true,
    global_paused: false,
    caption_resumed: hasCaptionWork,
    send_resumed: hasSendWork,
  });
}

async function replayControlCommand(originalMessage, text) {
  const replay = {
    ...(originalMessage || {}),
    text,
    entities: undefined,
  };
  const shadow = createShadowResponse();
  await commandHandler({ method: 'POST', body: { message: replay } }, shadow);
  return shadow.body;
}

function remainingInBatch(batch) {
  if (!batch || batch.completed || !Array.isArray(batch.item_ids)) return 0;
  return Math.max(0, batch.item_ids.length - Number(batch.next_index || 0));
}

function createShadowResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}
