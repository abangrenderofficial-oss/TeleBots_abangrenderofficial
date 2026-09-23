import { telegram, inlineKeyboard } from '../../telegram.js';
import {
  formatProfileKeyboardRows,
  getProfileForItem,
} from '../../format-profiles.js';
import {
  getFormatRemoveTerms,
  removeWordButtonLabel,
} from '../../remove-words.js';
import { getQueueItem, getSetting, updateQueueItem } from '../../store.js';
import { keepFocus } from './context.js';
import { getFormatReview, formatConfirmLabel } from './format-gate.js';
import {
  PIPELINE_REASONS,
  getPipelineState,
} from './pipeline-controller.js';
import { recaptionItemWithProfile } from './recaption.js';
import { getSentSyncMode, getSentSyncPending } from './sent-sync.js';

export function compactPreviewRows(itemId) {
  return [[
    { text: '✏️', callback_data: `edit:${itemId}` },
    { text: '✅ SEND', callback_data: `send:${itemId}` },
    { text: '🚀 SEND ALL', callback_data: 'sendall' },
  ]];
}

export async function compactRowsForItem(item) {
  if (String(item?.status || '').toUpperCase() !== 'SENT') return compactPreviewRows(item.id);

  const [lastSentId, fileRecordRaw] = await Promise.all([
    getSetting('last_sent_item_id').catch(() => null),
    getSetting('last_sent_file_record').catch(() => 0),
  ]);
  const fileRecord = Number.isFinite(Number(fileRecordRaw)) ? Number(fileRecordRaw) : 0;
  const statusText = String(lastSentId) === String(item.id)
    ? `🏁 LAST SENT · FILE ${fileRecord}`
    : '✅ SENT';

  return [
    [{ text: statusText, callback_data: 'noop' }],
    [
      { text: '✏️', callback_data: `edit:${item.id}` },
      { text: '🔁 SEND AGAIN', callback_data: `resend:${item.id}` },
      { text: '🚀 SEND ALL', callback_data: `resendall:${item.id}` },
    ],
  ];
}

export async function expandedPreviewRows(item, profile) {
  const removeTerms = await getFormatRemoveTerms(profile.id);
  const rows = formatProfileKeyboardRows(profile, item.id);
  if (rows.length) rows.shift();
  if (rows.length) rows.pop();
  rows.push([{ text: removeWordButtonLabel(removeTerms), callback_data: `fmt_removeword:${item.id}` }]);

  const review = await getFormatReview(item.admin_chat_id).catch(() => null);
  const confirmLabel = formatConfirmLabel(review, item.id);
  if (confirmLabel) {
    rows.push([{ text: confirmLabel, callback_data: `fmt_confirm:${item.id}` }]);
  }

  if (String(item.status || '').toUpperCase() === 'SENT') {
    const [mode, pending] = await Promise.all([
      getSentSyncMode(),
      getSentSyncPending(item.id),
    ]);
    rows.push([
      {
        text: pending ? '🔄 UPDATE GROUP · PENDING' : '🔄 UPDATE GROUP',
        callback_data: `syncgroup:${item.id}`,
      },
      {
        text: `⚡ AUTO: ${mode === 'auto' ? 'ON' : 'OFF'}`,
        callback_data: `syncmode:${item.id}`,
      },
    ]);
  }

  rows.push([{ text: '⬅️ BACK', callback_data: `back:${item.id}` }]);
  return rows;
}

export async function sendPreview(itemId, chatId) {
  const item = await getQueueItem(itemId);
  if (!item) return null;

  const pipeline = await getPipelineState(chatId).catch(() => null);
  if (pipeline?.paused) {
    const allowedFormatPreview = (
      pipeline.reason === PIPELINE_REASONS.NEW_FORMAT
      && String(pipeline.item_id || '') === String(item.id)
    );
    if (!allowedFormatPreview) return null;
  }

  const rows = await compactRowsForItem(item);

  if (item.preview_message_id) {
    await telegram('deleteMessage', {
      chat_id: chatId,
      message_id: item.preview_message_id,
    }).catch(() => {});
  }

  const copied = await telegram('copyMessage', {
    chat_id: chatId,
    from_chat_id: item.source_chat_id,
    message_id: item.source_message_id,
    parse_mode: 'HTML',
    disable_notification: true,
    reply_markup: inlineKeyboard(rows),
    caption: item.final_caption_html || '',
  });
  await updateQueueItem(item.id, { preview_message_id: copied.message_id });
  return copied;
}

export async function showEditMenu(itemId, chatId, fallbackMessageId = null) {
  const item = await getQueueItem(itemId);
  if (!item) return null;
  const profile = await getProfileForItem(item);
  if (!profile) return null;

  const rows = await expandedPreviewRows(item, profile);
  const messageId = item.preview_message_id || fallbackMessageId;
  if (!messageId) return null;

  await keepFocus(item.id);
  return telegram('editMessageCaption', {
    chat_id: chatId,
    message_id: messageId,
    caption: item.final_caption_html || '',
    parse_mode: 'HTML',
    reply_markup: inlineKeyboard(rows),
  });
}

export async function showCompactMenu(itemId, chatId, fallbackMessageId = null) {
  const item = await getQueueItem(itemId);
  if (!item) return null;
  const messageId = item.preview_message_id || fallbackMessageId;
  if (!messageId) return null;

  const rows = await compactRowsForItem(item);
  await keepFocus(item.id);
  return telegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: inlineKeyboard(rows),
  });
}

export async function reprocessItemWithProfile(itemId, profile) {
  const result = await recaptionItemWithProfile(itemId, profile, {
    reason: 'format_edit',
  });
  return result.item;
}
