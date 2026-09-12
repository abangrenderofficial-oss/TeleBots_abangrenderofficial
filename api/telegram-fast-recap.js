import { rejectUnauthorizedTelegramWebhook } from '../lib/bot/core/telegram-webhook-auth.js';
import entryHandler from './telegram-entry.js';
import { telegram, isAdminMessage, inlineKeyboard } from '../lib/telegram.js';
import {
  getFormatProfile,
  getProfileForItem,
  processMediaWithProfile,
} from '../lib/format-profiles.js';
import { applyFormatRemoveTerms } from '../lib/remove-words.js';
import { maybeAutoNameUntitledDocument } from '../lib/untitled-namer.js';
import {
  getQueueItem,
  getSetting,
  setSetting,
  updateQueueItem,
} from '../lib/store.js';

const CAPTION_PAUSE_PREFIX = 'caption_paused:';
const CAPTION_RECAP_ACTIVE_PREFIX = 'caption_recap_active:';
const DUP_BATCH_PREFIX = 'duplicate_review_batch:';
const FAST_ENGINE = 'fast_recaption_v1';
const AI_REFINE_CONCURRENCY = 3;

export default async function handler(req, res) {
  if (req.method === 'POST' && rejectUnauthorizedTelegramWebhook(req, res)) return;
  if (req.method !== 'POST') return entryHandler(req, res);

  const update = req.body || {};
  const message = update.message;
  const query = update.callback_query;

  if (
    query?.message
    && isAdminMessage({ from: query.from })
    && String(query.data || '').startsWith('dup_recap:')
  ) {
    return handleFastRecaption(query, res);
  }

  if (message?.chat?.type === 'private' && isAdminMessage(message)) {
    const text = String(message.text || '').trim().toLowerCase();
    const chatId = message.chat.id;
    const active = await getFastRecapState(chatId);

    if (text === '/resumecaption' && active) {
      return resumeFastRecaptionOnly(chatId, res);
    }

    if (text === '/resume' && active) {
      return resumeAllWithFastRecaptionFirst(req, res, chatId);
    }
  }

  return entryHandler(req, res);
}

async function handleFastRecaption(query, res) {
  const chatId = query.message.chat.id;
  const batchId = String(query.data || '').slice('dup_recap:'.length);
  await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  const batch = await getSetting(`${DUP_BATCH_PREFIX}${chatId}:${batchId}`).catch(() => null);
  const entries = Array.isArray(batch?.entries) ? batch.entries : [];
  if (!entries.length) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: 'Batch duplicate ni dah tak ada item untuk recaption.',
    }).catch(() => {});
    return res.status(200).json({ ok: true, recaptioned: 0 });
  }

  const state = {
    engine: FAST_ENGINE,
    batch_id: batchId,
    summary_message_id: query.message.message_id,
    summary_text: stripRecaptionStatus(query.message.text || ''),
    entries,
    phase: 'fast',
    fast_index: 0,
    refine_index: 0,
    refine_entries: [],
    fast_updated: 0,
    refined: 0,
    total: entries.length,
    next_index: 0,
    started_at: new Date().toISOString(),
  };
  await saveFastState(chatId, state);

  if (await isCaptionPaused(chatId)) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: `⏸ CAPTION masih STOP. ${entries.length} item recaption dah disimpan. /resume bila dah ready.`,
    }).catch(() => {});
    return res.status(200).json({ ok: true, caption_paused: true, queued_recaption: entries.length });
  }

  const result = await continueFastRecaption(chatId, state);
  return res.status(200).json({
    ok: true,
    recaptioned: result.fast_updated || 0,
    refined: result.refined || 0,
    paused: Boolean(result.paused),
  });
}

async function resumeFastRecaptionOnly(chatId, res) {
  await setCaptionPaused(chatId, false, 'fast_resume_caption');
  const state = await getFastRecapState(chatId);
  if (!state) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: '▶️ CAPTION aktif. Tak ada fast recaption tergantung.',
    }).catch(() => {});
    return res.status(200).json({ ok: true, caption_paused: false, remaining: 0 });
  }

  const result = await continueFastRecaption(chatId, state);
  return res.status(200).json({
    ok: true,
    caption_paused: Boolean(result.paused),
    recaptioned: result.fast_updated || 0,
    refined: result.refined || 0,
  });
}

async function resumeAllWithFastRecaptionFirst(req, res, chatId) {
  // Resume recaption BEFORE the normal global /resume handler is allowed to
  // continue a paused SEND batch. This guarantees the destination receives the
  // newest caption/settings after an owner correction.
  await setCaptionPaused(chatId, false, 'fast_global_resume');
  const state = await getFastRecapState(chatId);
  if (state) {
    const result = await continueFastRecaption(chatId, state);
    if (result.paused) {
      return res.status(200).json({ ok: true, global_paused: true, recaption_paused: true });
    }
  }

  return entryHandler(req, res);
}

async function continueFastRecaption(chatId, initialState) {
  let state = normalizeState(initialState);

  // STAGE 1 — FAST LOCAL RECAPTION.
  // No Gemini call here. Existing format rules, footer/remove-word logic and
  // current tick settings are applied first so the preview changes immediately.
  if (state.phase === 'fast') {
    for (let index = state.fast_index; index < state.entries.length; index += 1) {
      if (await isCaptionPaused(chatId)) {
        state.fast_index = index;
        state.next_index = index;
        await saveFastState(chatId, state);
        return { ...state, paused: true };
      }

      const entry = state.entries[index];
      const item = await getQueueItem(entry.item_id).catch(() => null);
      if (item) {
        const profile = await getProfileForItem(item).catch(() => null);
        if (profile) {
          const updated = await applyLocalRecaption(chatId, item, profile).catch((error) => {
            console.error('Fast local recaption failed:', error?.message || error);
            return null;
          });

          if (updated) {
            state.fast_updated += 1;
            if (needsAiRefine(updated, profile)) {
              state.refine_entries = mergeRefineEntry(state.refine_entries, updated.id);
            }
          }
        }
      }

      state.fast_index = index + 1;
      state.next_index = state.fast_index;
      state.total = state.entries.length;
      await saveFastState(chatId, state);
    }

    state.phase = 'refine';
    state.total = state.entries.length + state.refine_entries.length;
    state.next_index = state.entries.length + state.refine_index;
    await saveFastState(chatId, state);

    await updateSummaryProgress(chatId, state, false).catch(() => {});
  }

  // STAGE 2 — AI REFINE.
  // Only items that actually benefit from AI enter this stage. We run a maximum
  // of 3 at once so one AI call does not block the next whole batch.
  for (let start = state.refine_index; start < state.refine_entries.length; start += AI_REFINE_CONCURRENCY) {
    if (await isCaptionPaused(chatId)) {
      state.refine_index = start;
      state.next_index = state.entries.length + start;
      await saveFastState(chatId, state);
      return { ...state, paused: true };
    }

    const chunk = state.refine_entries.slice(start, start + AI_REFINE_CONCURRENCY);
    const results = await Promise.all(chunk.map((entry) => refineOneItem(chatId, entry.item_id)));

    if (results.some((result) => result?.paused)) {
      state.refine_index = start;
      state.next_index = state.entries.length + start;
      await saveFastState(chatId, state);
      return { ...state, paused: true };
    }

    state.refined += results.filter((result) => result?.updated).length;
    state.refine_index = start + chunk.length;
    state.next_index = state.entries.length + state.refine_index;
    await saveFastState(chatId, state);
  }

  await setSetting(`${CAPTION_RECAP_ACTIVE_PREFIX}${chatId}`, null);
  await updateSummaryProgress(chatId, state, true).catch(() => {});
  return { ...state, paused: false };
}

async function applyLocalRecaption(chatId, item, profile) {
  const base = await processMediaWithProfile({
    caption: item.original_caption || '',
    fileName: item.file_name || '',
    profile,
    fast: false,
    useAi: false,
  });
  const processed = await applyFormatRemoveTerms(profile.id, base);
  const nextStatus = String(item.status || '').toUpperCase() === 'SENT' ? 'SENT' : 'READY';

  const updated = await updateQueueItem(item.id, {
    generated_title: processed.title || null,
    final_caption_html: processed.finalCaptionHtml || null,
    caption_replaced: true,
    status: nextStatus,
    error_message: null,
  });

  await refreshPreview(chatId, updated);
  return updated;
}

async function refineOneItem(chatId, itemId) {
  let item = await getQueueItem(itemId).catch(() => null);
  if (!item) return { updated: false };

  if (await isCaptionPaused(chatId)) return { paused: true, updated: false };

  let profile = await getProfileForItem(item).catch(() => null);
  if (!profile) return { updated: false };

  // Translation/smart text refine uses Gemini only when the current profile asks
  // for it. If the owner changes a tick while AI is running, retry once with the
  // newest profile instead of letting an old result overwrite the correction.
  if (profile.actions?.translate) {
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      const profileVersion = String(profile.updated_at || '');
      const base = await processMediaWithProfile({
        caption: item.original_caption || '',
        fileName: item.file_name || '',
        profile,
        fast: false,
        useAi: true,
      });
      const processed = await applyFormatRemoveTerms(profile.id, base);

      if (await isCaptionPaused(chatId)) return { paused: true, updated: false };

      const latestProfile = await getFormatProfile(profile.id).catch(() => null);
      if (
        latestProfile
        && String(latestProfile.updated_at || '') !== profileVersion
        && attempt < 2
      ) {
        profile = latestProfile;
        continue;
      }

      item = await getQueueItem(itemId).catch(() => item);
      const nextStatus = String(item?.status || '').toUpperCase() === 'SENT' ? 'SENT' : 'READY';
      item = await updateQueueItem(itemId, {
        generated_title: processed.title || null,
        final_caption_html: processed.finalCaptionHtml || null,
        caption_replaced: true,
        status: nextStatus,
        error_message: null,
      }).catch(() => item);
      break;
    }
  }

  if (await isCaptionPaused(chatId)) return { paused: true, updated: false };

  // Vision remains photo-only and only changes photos that are still untitled.
  if (item?.media_kind === 'photo') {
    item = await maybeAutoNameUntitledDocument({ itemId, chatId }).catch(() => item);
  }

  if (await isCaptionPaused(chatId)) return { paused: true, updated: false };

  if (!item) item = await getQueueItem(itemId).catch(() => null);
  await refreshPreview(chatId, item);
  return { updated: Boolean(item) };
}

function needsAiRefine(item, profile) {
  return Boolean(profile?.actions?.translate || item?.media_kind === 'photo');
}

async function refreshPreview(chatId, item) {
  if (!item?.preview_message_id) return;
  const rows = await compactRowsForItem(item);
  await telegram('editMessageCaption', {
    chat_id: chatId,
    message_id: item.preview_message_id,
    caption: item.final_caption_html || '',
    parse_mode: 'HTML',
    reply_markup: inlineKeyboard(rows),
  }).catch(() => {});
}

async function updateSummaryProgress(chatId, state, done) {
  if (!state.summary_message_id) return;
  const baseText = stripRecaptionStatus(state.summary_text || '');
  let statusText;

  if (done) {
    const aiText = state.refine_entries.length
      ? ` AI refine: ${state.refined}/${state.refine_entries.length}.`
      : ' AI refine tak diperlukan.';
    statusText = `⚡ Fast recaption siap ${state.fast_updated} item.${aiText}`;
  } else if (state.refine_entries.length) {
    statusText = `⚡ Fast recaption siap ${state.fast_updated} item. ✨ AI refine ${state.refine_entries.length} item sedang jalan...`;
  } else {
    statusText = `⚡ Fast recaption siap ${state.fast_updated} item. AI refine tak diperlukan.`;
  }

  await telegram('editMessageText', {
    chat_id: chatId,
    message_id: state.summary_message_id,
    text: `${baseText}\n\n${statusText}`.slice(0, 3900),
    reply_markup: inlineKeyboard([[
      { text: '♻️ RECAPTION AGAIN', callback_data: `dup_recap:${state.batch_id}` },
    ]]),
    disable_web_page_preview: true,
  }).catch(() => {});
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

async function getFastRecapState(chatId) {
  const state = await getSetting(`${CAPTION_RECAP_ACTIVE_PREFIX}${chatId}`).catch(() => null);
  return state?.engine === FAST_ENGINE ? normalizeState(state) : null;
}

async function saveFastState(chatId, state) {
  const next = {
    ...state,
    engine: FAST_ENGINE,
    saved_at: new Date().toISOString(),
  };
  await setSetting(`${CAPTION_RECAP_ACTIVE_PREFIX}${chatId}`, next);
  return next;
}

function normalizeState(state) {
  return {
    ...state,
    engine: FAST_ENGINE,
    entries: Array.isArray(state?.entries) ? state.entries : [],
    refine_entries: Array.isArray(state?.refine_entries) ? state.refine_entries : [],
    phase: state?.phase === 'refine' ? 'refine' : 'fast',
    fast_index: Number(state?.fast_index || 0),
    refine_index: Number(state?.refine_index || 0),
    fast_updated: Number(state?.fast_updated || 0),
    refined: Number(state?.refined || 0),
    total: Number(state?.total || state?.entries?.length || 0),
    next_index: Number(state?.next_index || 0),
  };
}

function mergeRefineEntry(entries, itemId) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.some((entry) => String(entry?.item_id) === String(itemId))) return list;
  return [...list, { item_id: String(itemId) }];
}

async function isCaptionPaused(chatId) {
  const value = await getSetting(`${CAPTION_PAUSE_PREFIX}${chatId}`).catch(() => null);
  return Boolean(value === true || value?.paused);
}

async function setCaptionPaused(chatId, paused, reason) {
  await setSetting(`${CAPTION_PAUSE_PREFIX}${chatId}`, {
    paused: Boolean(paused),
    ...(paused ? { paused_at: new Date().toISOString() } : { resumed_at: new Date().toISOString() }),
    reason,
  });
}

function stripRecaptionStatus(text) {
  return String(text || '')
    .replace(/\n\n(?:♻️|⚡|✨)[\s\S]*$/i, '')
    .trim();
}
