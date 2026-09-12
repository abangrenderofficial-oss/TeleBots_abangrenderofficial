import sendAllHandler from './telegram-sendall.js';
import { telegram, isAdminMessage, inlineKeyboard } from '../lib/telegram.js';
import {
  formatProfileKeyboardRows,
  getProfileForItem,
  processMediaWithProfile,
  resolveFormatProfile,
} from '../lib/format-profiles.js';
import {
  applyFormatRemoveTerms,
  getFormatRemoveTerms,
  removeWordButtonLabel,
} from '../lib/remove-words.js';
import { maybeAutoNameUntitledDocument } from '../lib/untitled-namer.js';
import {
  findQueueItemsByFileUniqueId,
  getLatestAnyQueueItem,
  getQueueItem,
  getQueueItemBySourceMessage,
  getSetting,
  setSetting,
  updateQueueItem,
} from '../lib/store.js';

const CAPTION_PAUSE_PREFIX = 'caption_paused:';
const CAPTION_MEDIA_QUEUE_PREFIX = 'caption_media_queue:';
const NEW_FORMAT_DETECT_PREFIX = 'caption_new_format_detect:';
const NEW_FORMAT_HOLD_PREFIX = 'caption_new_format_hold:';
const MAX_QUEUED_MEDIA = 500;

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendAllHandler(req, res);

  const update = req.body || {};
  const message = update.message;
  const query = update.callback_query;

  if (query?.message && isAdminMessage({ from: query.from })) {
    return handleSafetyCallback(req, res, query);
  }

  if (message?.chat?.type === 'private' && isAdminMessage(message)) {
    return handleSafetyMessage(req, res, message);
  }

  return sendAllHandler(req, res);
}

async function handleSafetyMessage(req, res, message) {
  const chatId = message.chat.id;
  const text = String(message.text || '').trim().toLowerCase();
  const hold = await getHold(chatId);

  if (text === '/resume' || text === '/resumecaption') {
    if (hold?.item_id) {
      const finalized = await finalizeHeldFormat(chatId, hold);
      if (!finalized.ok) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: `⚠️ Format baru masih PAUSE sebab recaption akhir gagal. ${finalized.error || ''}`.trim(),
        }).catch(() => {});
        return res.status(200).json({ ok: true, new_format_paused: true, error: finalized.error || null });
      }
    }
    return sendAllHandler(req, res);
  }

  if (hasMedia(message)) {
    const detecting = await getSetting(`${NEW_FORMAT_DETECT_PREFIX}${chatId}`).catch(() => null);
    const currentHold = hold || await getHold(chatId);

    if (detecting?.source_message_id || currentHold?.item_id) {
      const queued = await queueHeldMedia(chatId, req.body);
      if (queued.firstQueued) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: '⏸ FORMAT BARU masih PAUSE. Media selepasnya aku queue dulu. Set format pada preview pertama, kemudian /resume.',
        }).catch(() => {});
      }
      return res.status(200).json({ ok: true, new_format_paused: true, queued: queued.count });
    }

    // Do not let duplicate/replayed media create a fresh format hold.
    const existing = await getQueueItemBySourceMessage(chatId, chatId, message.message_id).catch(() => null);
    if (existing?.id) return sendAllHandler(req, res);

    const fileUniqueId = extractFileUniqueId(message);
    if (fileUniqueId) {
      const matches = await findQueueItemsByFileUniqueId(chatId, fileUniqueId, 20).catch(() => []);
      if ((matches || []).some((row) => String(row?.status || '').toUpperCase() === 'SENT')) {
        return sendAllHandler(req, res);
      }
    }

    const media = identifyMedia(message);
    const resolved = await resolveFormatProfile({
      caption: message.caption || '',
      fileName: media.fileName || '',
      mediaKind: media.kind,
    }).catch(() => null);

    if (resolved?.isNew) {
      await setSetting(`${NEW_FORMAT_DETECT_PREFIX}${chatId}`, {
        source_message_id: message.message_id,
        profile_id: resolved.profile?.id || null,
        detected_at: new Date().toISOString(),
      });

      const shadow = createShadowResponse();
      try {
        // Pre-resolve above already saved the new profile. The normal handler now
        // sees it as known, so it can build the first local preview without doing
        // the old automatic AI/new-format refine path.
        await sendAllHandler(req, shadow);

        const item = await getQueueItemBySourceMessage(chatId, chatId, message.message_id).catch(() => null);
        if (!item?.id) {
          await setSetting(`${NEW_FORMAT_DETECT_PREFIX}${chatId}`, null).catch(() => {});
          return respondShadow(res, shadow);
        }

        const held = await updateQueueItem(item.id, {
          status: 'PENDING',
          error_message: null,
        }).catch(() => item);

        const holdState = {
          item_id: item.id,
          profile_id: resolved.profile?.id || null,
          source_message_id: message.message_id,
          detected_at: new Date().toISOString(),
          reason: 'new_format_requires_owner_approval',
        };

        await Promise.all([
          setSetting(`${NEW_FORMAT_HOLD_PREFIX}${chatId}`, holdState),
          setSetting(`${CAPTION_PAUSE_PREFIX}${chatId}`, {
            paused: true,
            paused_at: new Date().toISOString(),
            reason: 'new_format_detected',
            item_id: item.id,
          }),
          setSetting(`${NEW_FORMAT_DETECT_PREFIX}${chatId}`, null),
        ]);

        await showHeldCompact(chatId, held || item).catch(() => {});
        await telegram('sendMessage', {
          chat_id: chatId,
          text: `⚠️ FORMAT BARU DIKESAN — ${resolved.profile?.name || 'format baru'}\n\nAuto recaption aku PAUSE dekat sini supaya benda pelik tak terlepas ke group. Tekan ✏️ pada preview ni, set tick/caption ikut yang kau nak. Lepas confirm, hantar /resume. Media selepas ni aku queue dulu.`,
        }).catch(() => {});

        return res.status(shadow.statusCode || 200).json({
          ...(shadow.body || { ok: true }),
          new_format_paused: true,
          held_item_id: item.id,
        });
      } catch (error) {
        await setSetting(`${NEW_FORMAT_DETECT_PREFIX}${chatId}`, null).catch(() => {});
        throw error;
      }
    }

    return sendAllHandler(req, res);
  }

  // Track the currently focused/editing item. If an already-SENT caption changes
  // through buttons, footer/remove-word input, or normal correction chat, patch
  // the exact Telegram message in the destination group after the normal handler
  // finishes.
  const target = await captureEditableTarget(chatId);
  const before = target?.id ? await getQueueItem(target.id).catch(() => null) : null;
  const shadow = createShadowResponse();
  await sendAllHandler(req, shadow);
  const after = before?.id ? await getQueueItem(before.id).catch(() => null) : null;

  if (after?.id && String(after.status || '').toUpperCase() === 'SENT') {
    if (captionChanged(before, after)) await syncSentCaptionToGroup(after, chatId);
    if (target?.editing) await decorateSentEditMenu(chatId, after).catch(() => {});
  }

  // A held new-format item must remain unsendable while owner is still editing.
  const latestHold = await getHold(chatId);
  if (latestHold?.item_id && (!text.startsWith('/'))) {
    await keepHeldPending(latestHold.item_id).catch(() => {});
  }

  return respondShadow(res, shadow);
}

async function handleSafetyCallback(req, res, query) {
  const chatId = query.message.chat.id;
  const data = String(query.data || '');
  const [action, id] = data.split(':');

  if (action === 'delete_sent' && id) {
    return deleteExactSent(query, res, id);
  }

  const hold = await getHold(chatId);
  if (hold?.item_id) {
    const held = await getQueueItem(hold.item_id).catch(() => null);
    const clickedHeldPreview = held?.preview_message_id
      && String(held.preview_message_id) === String(query.message.message_id);
    const heldAction = String(id || '') === String(hold.item_id);

    if (
      (heldAction && ['send', 'resend', 'resendall'].includes(action))
      || (data === 'sendall' && clickedHeldPreview)
    ) {
      await telegram('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Format baru masih PAUSE. Set dulu, kemudian /resume.',
        show_alert: true,
      }).catch(() => {});
      return res.status(200).json({ ok: true, blocked_new_format: true });
    }

    if (action === 'back' && heldAction) {
      await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
      await keepHeldPending(hold.item_id).catch(() => {});
      await showHeldCompact(chatId, await getQueueItem(hold.item_id).catch(() => held)).catch(() => {});
      return res.status(200).json({ ok: true, new_format_paused: true });
    }
  }

  const targetId = id || null;
  const before = targetId ? await getQueueItem(targetId).catch(() => null) : null;
  const shadow = createShadowResponse();
  await sendAllHandler(req, shadow);
  let after = targetId ? await getQueueItem(targetId).catch(() => null) : null;

  if (hold?.item_id && String(targetId || '') === String(hold.item_id)) {
    after = await keepHeldPending(hold.item_id).catch(() => after);
  }

  if (after?.id && String(after.status || '').toUpperCase() === 'SENT') {
    if (captionChanged(before, after)) await syncSentCaptionToGroup(after, chatId);

    if (action === 'edit' || action.startsWith('fmt_')) {
      await decorateSentEditMenu(chatId, after).catch(() => {});
    } else if (action === 'back' || action === 'send' || action === 'resend') {
      await decorateSentCompact(chatId, after).catch(() => {});
    }
  }

  return respondShadow(res, shadow);
}

async function finalizeHeldFormat(chatId, hold) {
  try {
    let item = await getQueueItem(hold.item_id).catch(() => null);
    if (!item) throw new Error('Item format baru tak jumpa');

    const profile = await getProfileForItem(item).catch(() => null);
    if (!profile) throw new Error('Format profile tak jumpa');

    // Learned/local formats stay local. Translate is the only text case that
    // needs AI here; photo Vision remains isolated and photo-only below.
    const base = await processMediaWithProfile({
      caption: item.original_caption || '',
      fileName: item.file_name || '',
      profile,
      fast: false,
      useAi: Boolean(profile.actions?.translate),
    });
    const processed = await applyFormatRemoveTerms(profile.id, base);

    item = await updateQueueItem(item.id, {
      generated_title: processed.title || null,
      final_caption_html: processed.finalCaptionHtml || null,
      caption_replaced: true,
      status: 'READY',
      error_message: null,
    });

    if (item?.media_kind === 'photo') {
      item = await maybeAutoNameUntitledDocument({ itemId: item.id, chatId }).catch(() => item);
    }
    if (!item) item = await getQueueItem(hold.item_id).catch(() => null);

    await Promise.all([
      setSetting(`${NEW_FORMAT_HOLD_PREFIX}${chatId}`, null),
      setSetting(`${NEW_FORMAT_DETECT_PREFIX}${chatId}`, null),
      setSetting(`${CAPTION_PAUSE_PREFIX}${chatId}`, {
        paused: false,
        resumed_at: new Date().toISOString(),
        reason: 'new_format_approved',
      }),
    ]);

    if (item?.preview_message_id) {
      await telegram('editMessageCaption', {
        chat_id: chatId,
        message_id: item.preview_message_id,
        caption: item.final_caption_html || '',
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard(normalCompactRows(item.id)),
      }).catch(() => {});
    }

    return { ok: true, item };
  } catch (error) {
    await setSetting(`${CAPTION_PAUSE_PREFIX}${chatId}`, {
      paused: true,
      paused_at: new Date().toISOString(),
      reason: 'new_format_finalize_failed',
      item_id: hold?.item_id || null,
    }).catch(() => {});
    return { ok: false, error: String(error?.message || error).slice(0, 500) };
  }
}

async function syncSentCaptionToGroup(item, adminChatId) {
  if (!item?.destination_chat_id || !item?.destination_message_id) return { ok: false, missing_destination: true };
  try {
    await telegram('editMessageCaption', {
      chat_id: item.destination_chat_id,
      message_id: item.destination_message_id,
      caption: item.final_caption_html || '',
      parse_mode: 'HTML',
    });
    await setSetting(`sent_live_sync:${item.id}`, {
      ok: true,
      destination_chat_id: String(item.destination_chat_id),
      destination_message_id: item.destination_message_id,
      synced_at: new Date().toISOString(),
    }).catch(() => {});
    return { ok: true };
  } catch (error) {
    const text = String(error?.message || error).slice(0, 500);
    await setSetting(`sent_live_sync:${item.id}`, {
      ok: false,
      error: text,
      failed_at: new Date().toISOString(),
    }).catch(() => {});
    await telegram('sendMessage', {
      chat_id: adminChatId,
      text: `⚠️ Preview dah berubah tapi GROUP UPDATE gagal untuk item ni. ${text}`.slice(0, 1000),
    }).catch(() => {});
    return { ok: false, error: text };
  }
}

async function deleteExactSent(query, res, itemId) {
  const chatId = query.message.chat.id;
  const item = await getQueueItem(itemId).catch(() => null);
  if (!item?.destination_chat_id || !item?.destination_message_id) {
    await telegram('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Destination message untuk item ni tak jumpa.',
      show_alert: true,
    }).catch(() => {});
    return res.status(200).json({ ok: true, deleted: false });
  }

  try {
    await telegram('deleteMessage', {
      chat_id: item.destination_chat_id,
      message_id: item.destination_message_id,
    });

    const updated = await updateQueueItem(item.id, {
      status: 'READY',
      destination_chat_id: null,
      destination_message_id: null,
      sent_at: null,
      error_message: null,
    });

    const lastSentId = await getSetting('last_sent_item_id').catch(() => null);
    if (String(lastSentId || '') === String(item.id)) {
      await setSetting('last_sent_item_id', null).catch(() => {});
    }

    await telegram('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Deleted exact message tu sahaja dari group.',
    }).catch(() => {});

    if (updated?.preview_message_id) {
      await telegram('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: updated.preview_message_id,
        reply_markup: inlineKeyboard(normalCompactRows(updated.id)),
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true, deleted: true, item_id: item.id });
  } catch (error) {
    await telegram('answerCallbackQuery', {
      callback_query_id: query.id,
      text: String(error?.message || error).slice(0, 180),
      show_alert: true,
    }).catch(() => {});
    return res.status(200).json({ ok: true, deleted: false, error: String(error?.message || error) });
  }
}

async function decorateSentEditMenu(chatId, item) {
  if (!item?.preview_message_id) return;
  const profile = await getProfileForItem(item).catch(() => null);
  if (!profile) return;
  const removeTerms = await getFormatRemoveTerms(profile.id).catch(() => []);
  const rows = formatProfileKeyboardRows(profile, item.id);
  if (rows.length) rows.shift();
  if (rows.length) rows.pop();
  rows.unshift([{ text: '✅ SENT · LIVE GROUP SYNC', callback_data: 'noop' }]);
  rows.push([{ text: removeWordButtonLabel(removeTerms), callback_data: `fmt_removeword:${item.id}` }]);
  rows.push([{ text: '🗑 DELETE SENT', callback_data: `delete_sent:${item.id}` }]);
  rows.push([{ text: '⬅️ BACK', callback_data: `back:${item.id}` }]);

  await telegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: item.preview_message_id,
    reply_markup: inlineKeyboard(rows),
  });
}

async function decorateSentCompact(chatId, item) {
  if (!item?.preview_message_id) return;
  const [lastSentId, fileRecordRaw] = await Promise.all([
    getSetting('last_sent_item_id').catch(() => null),
    getSetting('last_sent_file_record').catch(() => 0),
  ]);
  const fileRecord = Number.isFinite(Number(fileRecordRaw)) ? Number(fileRecordRaw) : 0;
  const statusText = String(lastSentId || '') === String(item.id)
    ? `🏁 LAST SENT · FILE ${fileRecord}`
    : '✅ SENT';

  await telegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: item.preview_message_id,
    reply_markup: inlineKeyboard([
      [{ text: statusText, callback_data: 'noop' }],
      [
        { text: '✏️', callback_data: `edit:${item.id}` },
        { text: '🔁 SEND AGAIN', callback_data: `resend:${item.id}` },
        { text: '🚀 SEND ALL', callback_data: `resendall:${item.id}` },
      ],
      [{ text: '🗑 DELETE SENT', callback_data: `delete_sent:${item.id}` }],
    ]),
  });
}

async function showHeldCompact(chatId, item) {
  if (!item?.preview_message_id) return;
  await telegram('editMessageCaption', {
    chat_id: chatId,
    message_id: item.preview_message_id,
    caption: item.final_caption_html || '',
    parse_mode: 'HTML',
    reply_markup: inlineKeyboard([
      [{ text: '⚠️ NEW FORMAT · CAPTION PAUSED', callback_data: 'noop' }],
      [{ text: '✏️ SET FORMAT', callback_data: `edit:${item.id}` }],
    ]),
  });
}

async function keepHeldPending(itemId) {
  const item = await getQueueItem(itemId).catch(() => null);
  if (!item) return null;
  if (String(item.status || '').toUpperCase() === 'PENDING') return item;
  return updateQueueItem(item.id, { status: 'PENDING' });
}

async function captureEditableTarget(chatId) {
  const state = await getSetting('admin_state').catch(() => null);
  if (state?.item_id) {
    return {
      id: state.item_id,
      editing: ['FOCUS_ITEM', 'ADD_FORMAT_REMOVE_WORDS', 'EDIT_FORMAT_FOOTER', 'SET_CAPTION'].includes(state.mode),
    };
  }
  if (state?.mode === 'SET_CAPTION') {
    const latest = await getLatestAnyQueueItem(chatId).catch(() => null);
    if (latest?.id) return { id: latest.id, editing: true };
  }
  return null;
}

async function getHold(chatId) {
  return getSetting(`${NEW_FORMAT_HOLD_PREFIX}${chatId}`).catch(() => null);
}

async function queueHeldMedia(chatId, update) {
  const key = `${CAPTION_MEDIA_QUEUE_PREFIX}${chatId}`;
  const currentRaw = await getSetting(key).catch(() => null);
  const current = Array.isArray(currentRaw) ? currentRaw : [];
  const messageId = update?.message?.message_id;
  const updateId = update?.update_id;
  const exists = current.some((entry) => (
    (updateId != null && entry.update_id === updateId)
    || (messageId != null && entry.message_id === messageId)
  ));

  if (!exists) {
    current.push({
      update,
      update_id: updateId ?? null,
      message_id: messageId ?? null,
      queued_at: new Date().toISOString(),
      reason: 'new_format_pause',
    });
  }
  const trimmed = current.slice(-MAX_QUEUED_MEDIA);
  await setSetting(key, trimmed);
  return { count: trimmed.length, firstQueued: trimmed.length === 1 && !exists };
}

function normalCompactRows(itemId) {
  return [[
    { text: '✏️', callback_data: `edit:${itemId}` },
    { text: '✅ SEND', callback_data: `send:${itemId}` },
    { text: '🚀 SEND ALL', callback_data: 'sendall' },
  ]];
}

function captionChanged(before, after) {
  if (!before || !after) return false;
  return String(before.final_caption_html || '') !== String(after.final_caption_html || '')
    || String(before.generated_title || '') !== String(after.generated_title || '');
}

function identifyMedia(message) {
  if (message.document) return {
    kind: 'document',
    fileName: message.document.file_name || '',
  };
  if (message.photo) return { kind: 'photo', fileName: '' };
  if (message.video) return { kind: 'video', fileName: message.video.file_name || '' };
  if (message.animation) return { kind: 'animation', fileName: message.animation.file_name || '' };
  if (message.audio) return { kind: 'audio', fileName: message.audio.file_name || '' };
  return { kind: 'other', fileName: '' };
}

function extractFileUniqueId(message) {
  if (message.document) return message.document.file_unique_id || '';
  if (message.photo) return message.photo.at(-1)?.file_unique_id || '';
  if (message.video) return message.video.file_unique_id || '';
  if (message.animation) return message.animation.file_unique_id || '';
  if (message.audio) return message.audio.file_unique_id || '';
  return '';
}

function hasMedia(message) {
  return Boolean(message.document || message.photo || message.video || message.animation || message.audio);
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

function respondShadow(res, shadow) {
  return res.status(shadow.statusCode || 200).json(shadow.body || { ok: true });
}
