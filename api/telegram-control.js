import { rejectUnauthorizedTelegramWebhook } from '../lib/bot/core/telegram-webhook-auth.js';
import smartHandler from './telegram-smart.js';
import { telegram, isAdminMessage, inlineKeyboard } from '../lib/telegram.js';
import { getProfileForItem, processMediaWithProfile } from '../lib/format-profiles.js';
import { applyFormatRemoveTerms } from '../lib/remove-words.js';
import { maybeAutoNameUntitledDocument } from '../lib/untitled-namer.js';
import { getActiveSendBatch, pauseSending, resumeSending } from '../lib/send-control.js';
import {
  getQueueItem,
  getSetting,
  setSetting,
  updateQueueItem,
} from '../lib/store.js';

const CAPTION_PAUSE_PREFIX = 'caption_paused:';
const CAPTION_MEDIA_QUEUE_PREFIX = 'caption_media_queue:';
const CAPTION_RECAP_ACTIVE_PREFIX = 'caption_recap_active:';
const DUP_BATCH_PREFIX = 'duplicate_review_batch:';
const MAX_QUEUED_MEDIA = 120;
const RESUME_MEDIA_LIMIT = 30;

export default async function handler(req, res) {
  if (req.method === 'POST' && rejectUnauthorizedTelegramWebhook(req, res)) return;
  if (req.method !== 'POST') return smartHandler(req, res);

  const update = req.body || {};
  const message = update.message;
  const query = update.callback_query;

  if (message?.chat?.type === 'private' && isAdminMessage(message)) {
    const text = String(message.text || '').trim().toLowerCase();
    const chatId = message.chat.id;

    if (text === '/stopsend') return stopSend(chatId, res);
    if (text === '/resumesend') return resumeSend(chatId, message, res);
    if (text === '/stopcaption') return stopCaption(chatId, res);
    if (text === '/resumecaption') return resumeCaption(chatId, res);

    if (hasMedia(message) && await isCaptionPaused(chatId)) {
      const queued = await queuePausedMedia(chatId, update);
      if (queued.firstQueued) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: '⏸ CAPTION STOP. Media baru aku simpan dulu tanpa recaption. /resumecaption akan proses semula guna code + setting/tick yang paling latest.',
        }).catch(() => {});
      }
      return res.status(200).json({ ok: true, caption_paused: true, queued: queued.count });
    }
  }

  if (query?.message && isAdminMessage({ from: query.from }) && query.data?.startsWith('dup_recap:')) {
    return handleControlledRecaption(query, res);
  }

  return smartHandler(req, res);
}

async function stopSend(chatId, res) {
  const batch = await pauseSending(chatId);
  const remaining = remainingInBatch(batch);
  await telegram('sendMessage', {
    chat_id: chatId,
    text: remaining > 0
      ? `⏸ SEND STOP. Tinggal ${remaining} item belum dihantar. Betulkan dulu kalau perlu, kemudian /resumesend.`
      : '⏸ SEND STOP. Semua aktiviti hantar ke group ditahan sampai /resumesend.',
  });
  return res.status(200).json({ ok: true, send_paused: true, remaining });
}

async function resumeSend(chatId, originalMessage, res) {
  const batch = await resumeSending(chatId);
  const remaining = remainingInBatch(batch);

  if (remaining <= 0) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: '▶️ SEND aktif semula. Tak ada batch tergantung untuk disambung.',
    });
    return res.status(200).json({ ok: true, send_paused: false, remaining: 0 });
  }

  // Reuse the proven resumable batch logic in the legacy handler. It fetches
  // every item fresh from DB before sending, so any caption/code correction made
  // while paused is what gets sent after /resumesend.
  const replay = {
    ...(originalMessage || {}),
    text: '/resume',
    entities: undefined,
  };
  const shadow = createShadowResponse();
  await smartHandler({ method: 'POST', body: { message: replay } }, shadow);
  return res.status(200).json(shadow.body || { ok: true, send_resumed: true });
}

async function stopCaption(chatId, res) {
  await setSetting(`${CAPTION_PAUSE_PREFIX}${chatId}`, {
    paused: true,
    paused_at: new Date().toISOString(),
  });

  const queued = await getCaptionMediaQueue(chatId);
  const active = await getSetting(`${CAPTION_RECAP_ACTIVE_PREFIX}${chatId}`).catch(() => null);
  const activeRemaining = active ? Math.max(0, Number(active.total || 0) - Number(active.next_index || 0)) : 0;

  await telegram('sendMessage', {
    chat_id: chatId,
    text: `⏸ CAPTION STOP. Auto recaption dibekukan. Queued media: ${queued.length}${activeRemaining ? ` · baki recaption: ${activeRemaining}` : ''}. Kau masih boleh ubah tick/setting. /resumecaption akan sambung guna versi paling latest.`,
  });
  return res.status(200).json({ ok: true, caption_paused: true, queued: queued.length, active_remaining: activeRemaining });
}

async function resumeCaption(chatId, res) {
  await setSetting(`${CAPTION_PAUSE_PREFIX}${chatId}`, {
    paused: false,
    resumed_at: new Date().toISOString(),
  });

  let recaptioned = 0;
  const active = await getSetting(`${CAPTION_RECAP_ACTIVE_PREFIX}${chatId}`).catch(() => null);
  if (active?.batch_id) {
    const result = await continueDuplicateRecaption(chatId, active).catch((error) => ({ error }));
    if (result?.paused) {
      return res.status(200).json({ ok: true, caption_paused: true, recaptioned: result.updated || 0 });
    }
    recaptioned += Number(result?.updated || 0);
  }

  const queued = await getCaptionMediaQueue(chatId);
  const toProcess = queued.slice(0, RESUME_MEDIA_LIMIT);
  const remaining = queued.slice(toProcess.length);
  let replayed = 0;

  for (const entry of toProcess) {
    if (await isCaptionPaused(chatId)) {
      remaining.unshift(...toProcess.slice(replayed));
      break;
    }
    const shadow = createShadowResponse();
    await smartHandler({ method: 'POST', body: entry.update }, shadow).catch((error) => {
      console.error('Caption resume replay failed:', error?.message || error);
    });
    replayed += 1;
  }

  await setSetting(`${CAPTION_MEDIA_QUEUE_PREFIX}${chatId}`, remaining.length ? remaining : null);

  const extra = remaining.length
    ? ` Masih ada ${remaining.length} queued; hantar /resumecaption lagi untuk sambung.`
    : '';
  await telegram('sendMessage', {
    chat_id: chatId,
    text: `▶️ CAPTION aktif semula. ${recaptioned} recaption disambung, ${replayed} media diproses guna code + setting/tick terbaru.${extra}`,
  });

  return res.status(200).json({ ok: true, caption_paused: false, recaptioned, replayed, remaining: remaining.length });
}

async function handleControlledRecaption(query, res) {
  const chatId = query.message.chat.id;
  const batchId = String(query.data || '').slice('dup_recap:'.length);
  await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  const batch = await getSetting(`${DUP_BATCH_PREFIX}${chatId}:${batchId}`).catch(() => null);
  const entries = Array.isArray(batch?.entries) ? batch.entries : [];
  if (!entries.length) {
    await telegram('sendMessage', { chat_id: chatId, text: 'Batch duplicate ni dah tak ada item untuk recaption.' }).catch(() => {});
    return res.status(200).json({ ok: true, recaptioned: 0 });
  }

  const state = {
    batch_id: batchId,
    summary_message_id: query.message.message_id,
    summary_text: query.message.text || '',
    entries,
    next_index: 0,
    total: entries.length,
    updated: 0,
    started_at: new Date().toISOString(),
  };
  await setSetting(`${CAPTION_RECAP_ACTIVE_PREFIX}${chatId}`, state);

  if (await isCaptionPaused(chatId)) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: `⏸ CAPTION masih STOP. ${entries.length} item recaption ni dah disimpan. /resumecaption bila dah siap ubah code/tick.`,
    }).catch(() => {});
    return res.status(200).json({ ok: true, caption_paused: true, queued_recaption: entries.length });
  }

  const result = await continueDuplicateRecaption(chatId, state);
  return res.status(200).json({ ok: true, recaptioned: result.updated || 0, paused: Boolean(result.paused) });
}

async function continueDuplicateRecaption(chatId, initialState) {
  let state = {
    ...initialState,
    entries: Array.isArray(initialState.entries) ? initialState.entries : [],
    next_index: Number(initialState.next_index || 0),
    updated: Number(initialState.updated || 0),
    total: Number(initialState.total || initialState.entries?.length || 0),
  };

  for (let index = state.next_index; index < state.entries.length; index += 1) {
    if (await isCaptionPaused(chatId)) {
      state.next_index = index;
      await saveCaptionRecapState(chatId, state);
      return { paused: true, updated: state.updated };
    }

    const entry = state.entries[index];
    const item = await getQueueItem(entry.item_id).catch(() => null);
    if (item) {
      const profile = await getProfileForItem(item).catch(() => null);
      if (profile) {
        const base = await processMediaWithProfile({
          caption: item.original_caption || '',
          fileName: item.file_name || '',
          profile,
        });
        const processed = await applyFormatRemoveTerms(profile.id, base);
        const nextStatus = String(item.status || '').toUpperCase() === 'SENT' ? 'SENT' : 'READY';

        let updated = await updateQueueItem(item.id, {
          generated_title: processed.title || null,
          final_caption_html: processed.finalCaptionHtml || null,
          caption_replaced: true,
          status: nextStatus,
          error_message: null,
        }).catch(() => null);

        if (updated?.media_kind === 'photo') {
          updated = await maybeAutoNameUntitledDocument({ itemId: updated.id, chatId }).catch(() => updated);
        }
        if (!updated) updated = await getQueueItem(item.id).catch(() => null);

        if (updated?.preview_message_id) {
          const rows = await compactRowsForItem(updated);
          await telegram('editMessageCaption', {
            chat_id: chatId,
            message_id: updated.preview_message_id,
            caption: updated.final_caption_html || '',
            parse_mode: 'HTML',
            reply_markup: inlineKeyboard(rows),
          }).catch(() => {});
        }
        state.updated += 1;
      }
    }

    state.next_index = index + 1;
    await saveCaptionRecapState(chatId, state);
  }

  await setSetting(`${CAPTION_RECAP_ACTIVE_PREFIX}${chatId}`, null);
  if (state.summary_message_id) {
    const baseText = String(state.summary_text || '').replace(/\n\n♻️ Recaption siap[\s\S]*$/i, '');
    await telegram('editMessageText', {
      chat_id: chatId,
      message_id: state.summary_message_id,
      text: `${baseText}\n\n♻️ Recaption siap untuk ${state.updated} item. Preview dah guna setting/code terbaru.`.slice(0, 3900),
      reply_markup: inlineKeyboard([[
        { text: '♻️ RECAPTION AGAIN', callback_data: `dup_recap:${state.batch_id}` },
      ]]),
      disable_web_page_preview: true,
    }).catch(() => {});
  }
  return { paused: false, updated: state.updated };
}

async function compactRowsForItem(item) {
  if (String(item?.status || '').toUpperCase() !== 'SENT') {
    return [[
      { text: '✏️', callback_data: `edit:${item.id}` },
      { text: '✅ SEND', callback_data: `send:${item.id}` },
      { text: '🚀 SEND ALL', callback_data: 'sendall' },
    ]];
  }

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

async function queuePausedMedia(chatId, update) {
  const current = await getCaptionMediaQueue(chatId);
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
    });
  }
  const trimmed = current.slice(-MAX_QUEUED_MEDIA);
  await setSetting(`${CAPTION_MEDIA_QUEUE_PREFIX}${chatId}`, trimmed);
  return { count: trimmed.length, firstQueued: trimmed.length === 1 && !exists };
}

async function getCaptionMediaQueue(chatId) {
  const value = await getSetting(`${CAPTION_MEDIA_QUEUE_PREFIX}${chatId}`).catch(() => null);
  return Array.isArray(value) ? value : [];
}

async function saveCaptionRecapState(chatId, state) {
  const next = { ...state, saved_at: new Date().toISOString() };
  await setSetting(`${CAPTION_RECAP_ACTIVE_PREFIX}${chatId}`, next);
  return next;
}

async function isCaptionPaused(chatId) {
  const value = await getSetting(`${CAPTION_PAUSE_PREFIX}${chatId}`).catch(() => null);
  return Boolean(value === true || value?.paused);
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

function hasMedia(message) {
  return Boolean(message.document || message.photo || message.video || message.animation || message.audio);
}
