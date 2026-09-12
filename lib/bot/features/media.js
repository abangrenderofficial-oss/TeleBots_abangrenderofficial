import { duplicateNotice, inspectIncomingDuplicate } from '../../duplicates.js';
import {
  maybeAutoNameUntitledDocument,
  rememberUntitledMediaContext,
} from '../../untitled-namer.js';
import {
  getFormatProfile,
  processMediaWithProfile,
  resolveFormatProfile,
  saveItemFormatContext,
} from '../../format-profiles.js';
import { applyFormatRemoveTerms } from '../../remove-words.js';
import {
  createQueueItem,
  getQueueItem,
  getSetting,
  listQueueItems,
  setSetting,
  updateQueueItem,
} from '../../store.js';
import { telegram, inlineKeyboard } from '../../telegram.js';
import { keepFocus, sleep } from './context.js';
import { compactPreviewRows, sendPreview } from './preview-ui.js';

const PREVIEW_BURST_SETTLE_MS = 180;

export function hasMedia(message) {
  return Boolean(message?.document || message?.photo || message?.video || message?.animation || message?.audio);
}

export function identifyMedia(message) {
  if (message.document) {
    return {
      kind: 'document',
      fileName: message.document.file_name,
      fileUniqueId: message.document.file_unique_id,
    };
  }
  if (message.photo) {
    const p = message.photo.at(-1);
    return { kind: 'photo', fileUniqueId: p?.file_unique_id, fileId: p?.file_id };
  }
  if (message.video) {
    return {
      kind: 'video',
      fileName: message.video.file_name,
      fileUniqueId: message.video.file_unique_id,
    };
  }
  if (message.animation) {
    return {
      kind: 'animation',
      fileName: message.animation.file_name,
      fileUniqueId: message.animation.file_unique_id,
    };
  }
  if (message.audio) {
    return {
      kind: 'audio',
      fileName: message.audio.file_name,
      fileUniqueId: message.audio.file_unique_id,
    };
  }
  return { kind: 'other' };
}

export async function prepareMedia(message) {
  const media = identifyMedia(message);
  const duplicateInput = {
    adminChatId: message.chat.id,
    sourceChatId: message.chat.id,
    sourceMessageId: message.message_id,
    fileUniqueId: media.fileUniqueId || '',
    caption: message.caption || '',
    fileName: media.fileName || '',
  };

  const beforeAi = await inspectIncomingDuplicate(duplicateInput);
  if (beforeAi.kind === 'webhook_replay') return;
  if (beforeAi.kind === 'exact_file') return handleExactDuplicate(message, beforeAi);

  const item = await createQueueItem({
    admin_chat_id: message.chat.id,
    source_chat_id: message.chat.id,
    source_message_id: message.message_id,
    media_kind: media.kind,
    file_name: media.fileName || null,
    file_unique_id: media.fileUniqueId || null,
    original_caption: message.caption || null,
    generated_title: null,
    final_caption_html: null,
    status: 'PENDING',
    caption_replaced: false,
  });

  await rememberUntitledMediaContext({ itemId: item.id, media, message }).catch((error) => {
    console.error('Untitled photo context save failed:', error?.message || error);
  });

  try {
    const resolved = await resolveFormatProfile({
      caption: message.caption || '',
      fileName: media.fileName || '',
      mediaKind: media.kind,
    });

    const draftBase = await processMediaWithProfile({
      caption: message.caption || '',
      fileName: media.fileName || '',
      profile: resolved.profile,
      fast: true,
      useAi: false,
    });
    const draft = await applyFormatRemoveTerms(resolved.profile.id, draftBase);

    const duplicateResult = await inspectIncomingDuplicate({
      ...duplicateInput,
      generatedTitle: draft.title || '',
      currentItemId: item.id,
    });

    if (duplicateResult.kind === 'exact_file') {
      await updateQueueItem(item.id, {
        status: 'SKIPPED',
        error_message: 'Duplicate exact already SENT.',
      });
      return handleExactDuplicate(message, duplicateResult);
    }

    await updateQueueItem(item.id, {
      generated_title: draft.title || null,
      final_caption_html: draft.finalCaptionHtml || null,
      status: 'READY',
      caption_replaced: true,
      error_message: null,
    });

    await Promise.all([
      saveItemFormatContext(item.id, {
        profile_id: resolved.profile.id,
        signature: resolved.signature,
      }),
      keepFocus(item.id),
    ]);

    await queueOrderedPreviewFlush(message.chat.id);

    if (resolved.isNew) {
      await telegram('sendMessage', {
        chat_id: message.chat.id,
        text: `${resolved.profile.name} baru aku detect. Setting dekat preview ni khas untuk format ni. Kau ajar sekali, format sama lepas ni aku ingat.`,
      });
    }

    if (['exact_file_unsent', 'same_serial', 'same_title'].includes(duplicateResult.kind)) {
      const notice = duplicateNotice(duplicateResult);
      if (notice) await telegram('sendMessage', { chat_id: message.chat.id, text: notice });
    }

    await refineInitialPreview({
      itemId: item.id,
      chatId: message.chat.id,
      caption: message.caption || '',
      fileName: media.fileName || '',
      resolved,
      draft,
    });

    if (media.kind === 'photo') {
      const autoNamed = await maybeAutoNameUntitledDocument({
        itemId: item.id,
        chatId: message.chat.id,
      }).catch((error) => {
        console.error('Untitled photo auto-name failed:', error?.message || error);
        return null;
      });

      if (autoNamed?.preview_message_id) {
        await telegram('editMessageCaption', {
          chat_id: message.chat.id,
          message_id: autoNamed.preview_message_id,
          caption: autoNamed.final_caption_html || '',
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard(compactPreviewRows(autoNamed.id)),
        }).catch((error) => {
          console.error('Untitled photo preview edit failed:', error?.message || error);
        });
      }
    }
  } catch (error) {
    const errorText = String(error?.message || error).slice(0, 1000);
    await updateQueueItem(item.id, {
      status: 'FAILED',
      error_message: errorText,
    }).catch(() => {});
    await queueOrderedPreviewFlush(message.chat.id).catch(() => {});
    throw error;
  }
}

async function refineInitialPreview({ itemId, chatId, caption, fileName, resolved, draft }) {
  let currentProcessed = draft;

  const localBase = await processMediaWithProfile({
    caption,
    fileName,
    profile: resolved.profile,
    fast: false,
    useAi: false,
  });
  const localProcessed = await applyFormatRemoveTerms(resolved.profile.id, localBase);
  if (processedChanged(currentProcessed, localProcessed)) {
    await applyProcessedPreview(itemId, chatId, localProcessed);
    currentProcessed = localProcessed;
  }

  const shouldUseAi = Boolean(resolved.isNew || resolved.profile?.actions?.translate);
  if (!shouldUseAi) return;

  const latestProfile = await getFormatProfile(resolved.profile.id).catch(() => null);
  if (!latestProfile) return;
  if (String(latestProfile.updated_at || '') !== String(resolved.profile.updated_at || '')) return;

  const smartBase = await processMediaWithProfile({
    caption,
    fileName,
    profile: latestProfile,
    fast: false,
    useAi: true,
  });
  const smartProcessed = await applyFormatRemoveTerms(latestProfile.id, smartBase);
  if (processedChanged(currentProcessed, smartProcessed)) {
    await applyProcessedPreview(itemId, chatId, smartProcessed);
  }
}

function processedChanged(a, b) {
  return String(a?.title || '') !== String(b?.title || '')
    || String(a?.finalCaptionHtml || '') !== String(b?.finalCaptionHtml || '');
}

async function applyProcessedPreview(itemId, chatId, processed) {
  const current = await getQueueItem(itemId);
  if (!current) return null;
  if (['SENT', 'SKIPPED'].includes(String(current.status || '').toUpperCase())) return current;

  const nextTitle = processed?.title || null;
  const nextCaption = processed?.finalCaptionHtml || null;
  if (
    String(current.generated_title || '') === String(nextTitle || '')
    && String(current.final_caption_html || '') === String(nextCaption || '')
  ) {
    return current;
  }

  const updated = await updateQueueItem(itemId, {
    generated_title: nextTitle,
    final_caption_html: nextCaption,
    caption_replaced: true,
    status: current.status === 'FAILED' ? 'READY' : current.status,
    error_message: null,
  });

  if (updated?.preview_message_id) {
    await telegram('editMessageCaption', {
      chat_id: chatId,
      message_id: updated.preview_message_id,
      caption: updated.final_caption_html || '',
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard(compactPreviewRows(itemId)),
    }).catch((error) => {
      console.error('Fast preview refine edit failed:', error?.message || error);
    });
  }
  return updated;
}

async function queueOrderedPreviewFlush(chatId) {
  const tokenKey = `preview_flush_token:${chatId}`;
  const token = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await setSetting(tokenKey, { token, at: new Date().toISOString() });

  await sleep(PREVIEW_BURST_SETTLE_MS);
  const latest = await getSetting(tokenKey);
  if (latest?.token !== token) return;
  return flushOrderedPreviews(chatId);
}

async function flushOrderedPreviews(chatId) {
  const lockKey = `preview_flush_lock:${chatId}`;
  const dirtyKey = `preview_flush_dirty:${chatId}`;
  const now = Date.now();
  const running = await getSetting(lockKey).catch(() => null);

  if (running?.at) {
    const age = now - Date.parse(running.at);
    if (Number.isFinite(age) && age >= 0 && age < 30_000) {
      await setSetting(dirtyKey, true).catch(() => {});
      return;
    }
  }

  const lockToken = `${now}_${Math.random().toString(36).slice(2, 9)}`;
  await setSetting(lockKey, { token: lockToken, at: new Date().toISOString() });
  const confirmed = await getSetting(lockKey).catch(() => null);
  if (confirmed?.token !== lockToken) return;

  try {
    const rows = await listQueueItems(chatId, 500);
    const stalePendingBefore = Date.now() - (2 * 60 * 1000);
    const recentBefore = Date.now() - (60 * 60 * 1000);

    const waiting = (rows || [])
      .filter((row) => String(row.admin_chat_id) === String(chatId))
      .filter((row) => String(row.source_chat_id) === String(chatId))
      .filter((row) => !row.preview_message_id)
      .filter((row) => ['PENDING', 'READY'].includes(String(row.status || '').toUpperCase()))
      .filter((row) => {
        const created = Date.parse(row.created_at || 0);
        if (!Number.isFinite(created) || created < recentBefore) return false;
        if (String(row.status).toUpperCase() === 'PENDING' && created < stalePendingBefore) return false;
        return true;
      })
      .sort((a, b) => {
        const byMessage = Number(a.source_message_id) - Number(b.source_message_id);
        if (Number.isFinite(byMessage) && byMessage !== 0) return byMessage;
        return Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
      });

    for (const row of waiting) {
      if (String(row.status || '').toUpperCase() === 'PENDING') break;
      await sendPreview(row.id, chatId);
    }
  } finally {
    const current = await getSetting(lockKey).catch(() => null);
    if (current?.token === lockToken) await setSetting(lockKey, null).catch(() => {});

    const dirty = await getSetting(dirtyKey).catch(() => null);
    if (dirty) {
      await setSetting(dirtyKey, null).catch(() => {});
      await queueOrderedPreviewFlush(chatId).catch((error) => {
        console.error('Ordered preview reflush failed:', error?.message || error);
      });
    }
  }
}

async function handleExactDuplicate(message, duplicateResult) {
  const oldItem = duplicateResult.match;
  if (oldItem?.id) await keepFocus(oldItem.id).catch(() => {});

  let deleted = false;
  try {
    await telegram('deleteMessage', {
      chat_id: message.chat.id,
      message_id: message.message_id,
    });
    deleted = true;
  } catch (error) {
    console.error('Duplicate auto-delete failed:', error?.message || error);
  }

  const notice = duplicateNotice(duplicateResult);
  const resultText = deleted
    ? 'Copy baru tu aku delete sebab benda sama memang dah pernah berjaya SEND ke group.'
    : 'Benda ni memang dah pernah SENT ke group, tapi Telegram tak bagi aku delete mesej baru tu.';

  return telegram('sendMessage', {
    chat_id: message.chat.id,
    text: `${notice}\n\n${resultText}`.slice(0, 3900),
  });
}
