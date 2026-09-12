import { rejectUnauthorizedTelegramWebhook } from '../lib/bot/core/telegram-webhook-auth.js';
import globalHandler from './telegram-global.js';
import { isAdminMessage } from '../lib/telegram.js';
import { markDuplicateForReview } from '../lib/duplicate-review.js';
import {
  findQueueItemsByFileUniqueId,
  getQueueItemBySourceMessage,
  setSetting,
} from '../lib/store.js';

const DUP_OVERRIDE_PREFIX = 'duplicate_override:';

export default async function handler(req, res) {
  if (req.method === 'POST' && rejectUnauthorizedTelegramWebhook(req, res)) return;
  if (req.method !== 'POST') return globalHandler(req, res);

  const message = req.body?.message;
  if (!isPrivateAdminMedia(message)) return globalHandler(req, res);

  const chatId = message.chat.id;
  const sourceMessageId = message.message_id;
  const fileUniqueId = extractFileUniqueId(message);
  if (!fileUniqueId) return globalHandler(req, res);

  // Detect previously SENT exact media directly from DB. This sits above every
  // legacy handler so duplicate review cannot fall back to deleteMessage.
  const matches = await findQueueItemsByFileUniqueId(chatId, fileUniqueId, 30).catch(() => []);
  const oldSent = (matches || []).find((row) => String(row?.status || '').toUpperCase() === 'SENT');
  if (!oldSent?.id) return globalHandler(req, res);

  // Telegram can retry the same webhook. If the fresh duplicate row already
  // exists, do NOT send it through the processing chain again. Just make sure it
  // is registered in the grouped duplicate review and acknowledge the retry.
  const replay = await getQueueItemBySourceMessage(chatId, chatId, sourceMessageId).catch(() => null);
  if (replay?.id) {
    if (String(replay.id) !== String(oldSent.id)) {
      await markDuplicateForReview({
        chatId,
        itemId: replay.id,
        matchId: oldSent.id,
      }).catch(() => {});
    }
    return res.status(200).json({
      ok: true,
      webhook_replay: true,
      duplicate_review: true,
    });
  }

  // Allow THIS one Telegram source message through normal preview/caption logic.
  // The override is scoped to chat + message id and is removed after processing.
  const overrideKey = `${DUP_OVERRIDE_PREFIX}${chatId}:${sourceMessageId}`;
  await setSetting(overrideKey, {
    allow: true,
    match_id: oldSent.id,
    detected_at: new Date().toISOString(),
    source: 'top_level_duplicate_gate',
  });

  const shadow = createShadowResponse();
  try {
    await globalHandler(req, shadow);

    const fresh = await getQueueItemBySourceMessage(chatId, chatId, sourceMessageId).catch(() => null);
    if (fresh?.id) {
      await markDuplicateForReview({
        chatId,
        itemId: fresh.id,
        matchId: oldSent.id,
      });
    }
  } finally {
    await setSetting(overrideKey, null).catch(() => {});
  }

  return res.status(shadow.statusCode || 200).json(shadow.body || {
    ok: true,
    duplicate_review: true,
  });
}

function isPrivateAdminMedia(message) {
  return Boolean(
    message
    && message.chat?.type === 'private'
    && isAdminMessage(message)
    && (message.document || message.photo || message.video || message.animation || message.audio)
  );
}

function extractFileUniqueId(message) {
  if (message.document) return message.document.file_unique_id || '';
  if (message.photo) return message.photo.at(-1)?.file_unique_id || '';
  if (message.video) return message.video.file_unique_id || '';
  if (message.animation) return message.animation.file_unique_id || '';
  if (message.audio) return message.audio.file_unique_id || '';
  return '';
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
