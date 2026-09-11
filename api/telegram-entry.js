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
  if (req.method !== 'POST') return globalHandler(req, res);

  const message = req.body?.message;
  if (!isPrivateAdminMedia(message)) return globalHandler(req, res);

  const chatId = message.chat.id;
  const sourceMessageId = message.message_id;

  // Telegram may retry the same webhook. Never create another queue item for
  // the exact same source message.
  const replay = await getQueueItemBySourceMessage(chatId, chatId, sourceMessageId).catch(() => null);
  if (replay) return globalHandler(req, res);

  const fileUniqueId = extractFileUniqueId(message);
  if (!fileUniqueId) return globalHandler(req, res);

  // Top-level gate: do this BEFORE every other wrapper. This guarantees the old
  // legacy auto-delete path can never eat a reviewed duplicate before the smart
  // duplicate UI gets a chance to process it.
  const matches = await findQueueItemsByFileUniqueId(chatId, fileUniqueId, 30).catch(() => []);
  const oldSent = (matches || []).find((row) => String(row?.status || '').toUpperCase() === 'SENT');
  if (!oldSent?.id) return globalHandler(req, res);

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
