import { randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { withVisionSlot } from '../../ai-concurrency.js';
import { isAiUnavailableError } from '../../ai-gate.js';
import { duplicateNotice, inspectIncomingDuplicate } from '../../duplicates.js';
import {
  getProfileForItem,
  resolveFormatProfile,
} from '../../format-profiles.js';
import {
  maybeAutoNameUntitledDocument,
  rememberUntitledMediaContext,
} from '../../untitled-namer.js';
import {
  createQueueItem,
  getQueueItem,
  getSetting,
  listQueueItems,
  setSetting,
  updateQueueItem,
} from '../../store.js';
import { telegram, inlineKeyboard } from '../../telegram.js';
import { keepFocus } from './context.js';
import { isFormatPipelinePaused } from './format-gate.js';
import { identifyMedia, processPendingItem } from './media.js';
import {
  PIPELINE_REASONS,
  clearDirectAiBypass,
  clearPreparedProfileRevision,
  getPipelineState,
  isDirectAiBypass,
  pausePipeline,
  preparedProfileRevisionIsCurrent,
  stampPreparedProfileRevision,
} from './pipeline-controller.js';
import { compactPreviewRows } from './preview-ui.js';
import {
  recaptionItemWithProfile,
  validateProcessedAgainstProfile,
} from './recaption.js';

export const IMMEDIATE_MEDIA_CONCURRENCY = 10;
export const IMMEDIATE_MEDIA_MAX_ITEMS_PER_INVOCATION = 10;
export const IMMEDIATE_MEDIA_SENDER_CONCURRENCY = 1;
export const IMMEDIATE_MEDIA_AUDIT_CONCURRENCY = 3;
export const IMMEDIATE_MEDIA_WORKER_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/recaption-worker';

const TOKEN_PREFIX = 'immediate_media_worker_token:';
const FLOOR_PREFIX = 'immediate_media_queue_floor:';
const PAUSE_PREFIX = 'immediate_media_pause:';
const FORMAT_NOTICE_PREFIX = 'immediate_format_queue_notice:';

function tokenKey(chatId) {
  return `${TOKEN_PREFIX}${chatId}`;
}

function floorKey(chatId) {
  return `${FLOOR_PREFIX}${chatId}`;
}

function pauseKey(chatId) {
  return `${PAUSE_PREFIX}${chatId}`;
}

export async function isImmediateMediaPaused(chatId) {
  const gate = await getSetting(pauseKey(chatId)).catch(() => null);
  return Boolean(gate?.paused);
}

export async function enqueueImmediateMedia(message) {
  const chatId = message.chat.id;
  const media = identifyMedia(message);
  const duplicateInput = {
    adminChatId: chatId,
    sourceChatId: chatId,
    sourceMessageId: message.message_id,
    fileUniqueId: media.fileUniqueId || '',
    caption: message.caption || '',
    fileName: media.fileName || '',
  };

  const beforeAi = await inspectIncomingDuplicate(duplicateInput);
  if (beforeAi.kind === 'webhook_replay') return { ok: true, replay: true };
  if (beforeAi.kind === 'exact_file') return handleExactDuplicate(message, beforeAi);

  await ensureImmediateQueueFloor(chatId);
  await ensureImmediateWorkerToken(chatId);

  const item = await createQueueItem({
    admin_chat_id: chatId,
    source_chat_id: chatId,
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

  if (await isFormatPipelinePaused(chatId)) {
    await notifyQueuedBehindFormatGate(chatId);
    return { ok: true, queued: true, blocked: 'format_review', item_id: item.id };
  }

  if (await isImmediateMediaPaused(chatId)) {
    return { ok: true, queued: true, blocked: 'pipeline_pause', item_id: item.id };
  }

  // The webhook only enqueues. Ten preparation jobs run behind the scenes while
  // exactly one sender is allowed to publish final previews in source order.
  waitUntil(kickImmediateMediaWorker(chatId).catch((error) => {
    console.error('Immediate media worker kick failed:', error?.message || error);
  }));

  return { ok: true, queued: true, item_id: item.id };
}

export async function kickImmediateMediaWorker(chatId) {
  const workerSecret = await ensureImmediateWorkerToken(chatId);
  const response = await fetch(IMMEDIATE_MEDIA_WORKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'immediate_media',
      chat_id: String(chatId),
      worker_secret: workerSecret,
    }),
  });
  if (!response.ok) throw new Error(`Immediate media worker kick HTTP ${response.status}`);
  return response.json().catch(() => ({ ok: true }));
}

// A worker request cannot safely HTTP-call the same Vercel function again;
// Vercel loop protection can answer 508. Schedule the next request through
// Supabase pg_net instead, which starts a fresh external request after release.
export async function scheduleImmediateMediaContinuation(chatId, workerSecret) {
  return supabaseRpc('schedule_immediate_media_worker', {
    p_url: IMMEDIATE_MEDIA_WORKER_URL,
    p_admin_chat_id: Number(chatId),
    p_worker_secret: String(workerSecret || ''),
  });
}

export async function runImmediateMediaQueue({ chatId, workerSecret }) {
  const expectedSecret = String(await getSetting(tokenKey(chatId)).catch(() => '') || '');
  if (!expectedSecret || String(workerSecret || '') !== expectedSecret) {
    return { ok: false, status_code: 403, error: 'invalid immediate media worker credentials' };
  }

  const leaseToken = randomUUID();
  const claimed = await claimImmediateMediaWorker(chatId, leaseToken);
  if (!claimed) {
    return { ok: true, claimed: false, busy: true, chat_id: String(chatId) };
  }

  try {
    if (await isImmediateMediaPaused(chatId)) {
      return { ok: true, paused: true, should_continue: false, chat_id: String(chatId) };
    }
    if (await isFormatPipelinePaused(chatId)) {
      return { ok: true, paused: true, format_review: true, should_continue: false, chat_id: String(chatId) };
    }

    // Recover a fully-prepared item left behind by a previous invocation before
    // starting more preparation. The sender remains strictly one-at-a-time.
    const recoveredSent = await drainPreparedPreviews(chatId, { limit: 30 });
    if (recoveredSent.length) {
      await auditSentItems(recoveredSent, chatId);
    }

    const pending = await listImmediatePending(chatId);
    if (!pending.length) {
      const state = await immediateQueueState(chatId);
      return {
        ok: true,
        done: !state.hasWork,
        processed: 0,
        sent: recoveredSent.length,
        remaining: state.remaining,
        blocked: state.blocked,
        should_continue: state.hasWork && !state.blocked,
        chat_id: String(chatId),
        worker_secret: state.hasWork && !state.blocked ? String(workerSecret) : undefined,
      };
    }

    const wave = await takeImmediateWave(pending);
    if (!wave.length) {
      return { ok: true, done: false, processed: 0, remaining: pending.length, should_continue: false, chat_id: String(chatId) };
    }

    // Start every preparation immediately. We do NOT Promise.all before sending:
    // the single sender waits only for item N while N+1..N+9 keep preparing in
    // parallel behind it. This is the kitchen/one-counter architecture.
    const prepPromises = wave.map((item) => prepareImmediateItem(item, chatId));
    const sentIds = [];
    let boundaryError = null;

    for (let index = 0; index < wave.length; index += 1) {
      const item = wave[index];
      const entry = await prepPromises[index];

      if (entry.error) {
        boundaryError = entry.error;
        break;
      }
      if (entry.result?.paused_new_format || entry.result?.blocked_by || entry.result?.paused_ai) {
        break;
      }
      if (!entry.result?.prepared) continue;

      try {
        const sent = await sendPreparedPreviewOnce(item.id, chatId);
        if (sent?.sent) sentIds.push(item.id);
        if (sent?.paused || sent?.busy || sent?.stale_profile) break;
      } catch (error) {
        boundaryError = error;
        console.error('Ordered immediate preview send failed:', item.id, error?.message || error);
        break;
      }
    }

    // Every prep promise was already running. Settle the tail so a later item can
    // remain safely PREPARED in DB without leaking past an earlier failed item.
    await Promise.allSettled(prepPromises);

    if (sentIds.length) {
      await auditSentItems(sentIds, chatId);
    }

    const formatPaused = await isFormatPipelinePaused(chatId);
    const maintenancePaused = await isImmediateMediaPaused(chatId);
    const state = await immediateQueueState(chatId);
    const shouldContinue = Boolean(
      !boundaryError
      && !formatPaused
      && !maintenancePaused
      && state.hasWork
      && !state.blocked,
    );

    return {
      ok: true,
      done: !state.hasWork,
      processed: wave.length,
      sent: recoveredSent.length + sentIds.length,
      remaining: state.remaining,
      blocked: Boolean(boundaryError || state.blocked),
      error: boundaryError ? String(boundaryError?.message || boundaryError).slice(0, 500) : undefined,
      paused: formatPaused || maintenancePaused,
      format_review: formatPaused,
      maintenance_pause: maintenancePaused,
      should_continue: shouldContinue,
      chat_id: String(chatId),
      worker_secret: shouldContinue ? String(workerSecret) : undefined,
    };
  } finally {
    await releaseImmediateMediaWorker(chatId, leaseToken).catch((error) => {
      console.error('Immediate media worker lease release failed:', error?.message || error);
    });
  }
}

async function prepareImmediateItem(item, chatId) {
  let profile = null;
  let aiBypass = false;
  try {
    const preflight = await resolveFormatProfile({
      caption: item.original_caption || '',
      fileName: item.file_name || '',
      mediaKind: item.media_kind || 'other',
    });
    const confirmed = preflight.profile?.id
      ? await getSetting(`format_profile_confirmed:${preflight.profile.id}`).catch(() => null)
      : null;
    const needsReview = Boolean(
      preflight.isNew
      || !preflight.profile
      || (!preflight.profile.learned && !confirmed?.confirmed),
    );

    if (needsReview) {
      // New formats still use the existing owner-review UI and hard pause. This
      // is intentionally the only immediate path allowed to preview before the
      // final background-preparation pipeline.
      const result = await processPendingItem(item, {
        resumed: true,
        immediateWorker: true,
      });
      return { item, result };
    }

    profile = await getProfileForItem(item);
    if (!profile) throw new Error('Immediate media format profile tak jumpa');
    aiBypass = await isDirectAiBypass(chatId, item.id);

    await recaptionItemWithProfile(item.id, profile, {
      reason: 'immediate_prepare',
      syncSent: false,
      keepPending: true,
      forceTranslateAllLanguages: true,
      aiBypass,
    });

    if (item.media_kind === 'photo' && !aiBypass) {
      await withVisionSlot(() => maybeAutoNameUntitledDocument({
        itemId: item.id,
        chatId,
      }));
    }

    const prepared = await getQueueItem(item.id);
    if (!prepared) throw new Error('Immediate media item hilang selepas prepare');

    const validation = validatePreparedItem(prepared, profile, {
      allowAiBypass: aiBypass,
    });
    if (!validation.ok) {
      throw new Error(`Immediate prepare validation failed: ${validation.errors.join('; ')}`);
    }

    const updated = await updateQueueItem(item.id, {
      status: 'PENDING',
      immediate_prepared_at: new Date().toISOString(),
      immediate_audit_at: null,
      preview_send_state: null,
      preview_send_token: null,
      preview_send_started_at: null,
      error_message: null,
    });
    await stampPreparedProfileRevision(item.id, profile.id);
    await keepFocus(item.id).catch(() => {});

    return {
      item,
      result: {
        ok: true,
        prepared: true,
        item_id: item.id,
        validation,
        ai_bypassed: aiBypass,
        prepared_item: updated,
      },
    };
  } catch (error) {
    const errorText = String(error?.message || error).slice(0, 1000);
    const aiFailure = Boolean(
      isAiUnavailableError(error)
      || /translation unavailable|translate failed|vision unavailable|photo still has no human-readable title after vision fallback/i.test(errorText),
    );

    if (aiFailure) {
      await updateQueueItem(item.id, {
        status: 'PENDING',
        immediate_prepared_at: null,
        error_message: `AI_WAIT: ${errorText}`,
      }).catch(() => {});
      await clearPreparedProfileRevision(item.id).catch(() => {});

      const gate = await pausePipeline({
        chatId,
        reason: PIPELINE_REASONS.AI_LIMIT,
        itemId: item.id,
        profileId: profile?.id || null,
        scope: 'direct_item',
        meta: {
          media_kind: item.media_kind || null,
          source_message_id: item.source_message_id || null,
          error: errorText.slice(0, 500),
        },
      });

      if (
        gate?.reason === PIPELINE_REASONS.AI_LIMIT
        && String(gate.item_id || '') === String(item.id)
      ) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: [
            '⚠️ AI yang diperlukan untuk item ini tak available / limit sekarang.',
            'Queue aku pause sebelum sender supaya item selepasnya tak lompat.',
            'Boleh tunggu dan retry kemudian, atau teruskan item ini tanpa AI.',
          ].join('\n'),
          reply_markup: inlineKeyboard([[
            { text: '▶️ TERUSKAN TANPA AI', callback_data: `ai_continue_direct:${item.id}` },
          ]]),
        }).catch(() => {});
      }

      return {
        item,
        result: {
          ok: true,
          paused_ai: true,
          blocked_by: item.id,
        },
      };
    }

    await updateQueueItem(item.id, {
      status: 'FAILED',
      immediate_prepared_at: null,
      error_message: errorText,
    }).catch(() => {});
    await clearPreparedProfileRevision(item.id).catch(() => {});
    console.error('Immediate media prepare failed:', item.id, errorText);
    return { item, error };
  }
}

function validatePreparedItem(item, profile, options = {}) {
  const processed = {
    title: item.generated_title || '',
    finalCaptionHtml: item.final_caption_html || '',
  };
  const validation = validateProcessedAgainstProfile(processed, profile, item, {
    allowUntranslated: Boolean(options.allowAiBypass),
  });
  const errors = [...validation.errors];

  if (
    !options.allowAiBypass
    && item.media_kind === 'photo'
    && profile?.actions?.take_title
    && !hasHumanReadableTitle(item.generated_title)
  ) {
    errors.push('photo still has no human-readable title after vision fallback');
  }

  return { ok: errors.length === 0, errors };
}

function hasHumanReadableTitle(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !looksLikeSerial(line))
    .filter((line) => !/^(?:\(?none\)?|\(?untitled\)?|no\s*title|n\/?a|null|undefined|-)$/i.test(line));
  return lines.length > 0;
}

function looksLikeSerial(value) {
  const token = String(value || '').trim();
  return token.length >= 5
    && token.length <= 80
    && !/\s/.test(token)
    && /\d/.test(token)
    && /[A-Za-z._-]/.test(token)
    && !/^https?:/i.test(token)
    && /^[A-Za-z0-9._-]+$/.test(token);
}

async function sendPreparedPreviewOnce(itemId, chatId) {
  const item = await getQueueItem(itemId);
  if (!item) throw new Error('Prepared item tak jumpa masa SEND');
  if (item.preview_message_id) return { ok: true, sent: false, already_sent: true };
  if (!item.immediate_prepared_at || String(item.status || '').toUpperCase() !== 'PENDING') {
    return { ok: true, sent: false, not_prepared: true };
  }

  const pipeline = await getPipelineState(chatId).catch(() => null);
  if (pipeline?.paused) {
    return { ok: true, sent: false, paused: true, reason: pipeline.reason };
  }

  const profile = await getProfileForItem(item);
  if (!profile) throw new Error('Prepared item format profile tak jumpa masa SEND');
  const revisionCurrent = await preparedProfileRevisionIsCurrent(item.id, profile.id);
  if (!revisionCurrent) {
    await Promise.all([
      updateQueueItem(item.id, {
        immediate_prepared_at: null,
        immediate_audit_at: null,
        preview_send_state: null,
        preview_send_token: null,
        preview_send_started_at: null,
        error_message: null,
      }),
      clearPreparedProfileRevision(item.id),
    ]);
    return { ok: true, sent: false, stale_profile: true };
  }

  const sendToken = randomUUID();
  const claimed = await supabaseRpc('claim_queue_preview_send', {
    p_item_id: item.id,
    p_token: sendToken,
    p_stale_seconds: 180,
  });
  if (claimed !== true) {
    const current = await getQueueItem(item.id).catch(() => null);
    return {
      ok: true,
      sent: false,
      already_sent: Boolean(current?.preview_message_id),
      busy: !current?.preview_message_id,
    };
  }

  let copied = null;
  try {
    // Re-read the master gate after the atomic claim. A /stop or format/AI pause
    // racing with the sender cannot leak a new Telegram preview past this point.
    const gateAfterClaim = await getPipelineState(chatId).catch(() => null);
    if (gateAfterClaim?.paused) {
      await supabaseRpc('release_queue_preview_send', {
        p_item_id: item.id,
        p_token: sendToken,
      }).catch(() => {});
      return { ok: true, sent: false, paused: true, reason: gateAfterClaim.reason };
    }

    copied = await telegram('copyMessage', {
      chat_id: chatId,
      from_chat_id: item.source_chat_id,
      message_id: item.source_message_id,
      parse_mode: 'HTML',
      disable_notification: true,
      reply_markup: inlineKeyboard(compactPreviewRows(item.id)),
      caption: item.final_caption_html || '',
    });

    const completed = await supabaseRpc('complete_queue_preview_send', {
      p_item_id: item.id,
      p_token: sendToken,
      p_preview_message_id: Number(copied.message_id),
    });
    if (completed !== true) {
      // Telegram succeeded but DB commit did not. Delete the copied preview so a
      // retry cannot create an orphan duplicate like the old race did.
      await telegram('deleteMessage', {
        chat_id: chatId,
        message_id: copied.message_id,
      }).catch(() => {});
      throw new Error('Preview send DB commit lost ownership; copied message rolled back');
    }

    await clearDirectAiBypass(chatId, item.id).catch(() => {});
    return { ok: true, sent: true, preview_message_id: copied.message_id };
  } catch (error) {
    await supabaseRpc('release_queue_preview_send', {
      p_item_id: item.id,
      p_token: sendToken,
    }).catch(() => {});
    throw error;
  }
}

async function drainPreparedPreviews(chatId, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 30, 100));
  const rows = await listImmediateRows(chatId);
  const sent = [];

  for (const item of rows) {
    if (sent.length >= limit) break;
    if (item.preview_message_id) continue;

    const status = String(item.status || '').toUpperCase();
    if (status === 'FAILED') break;
    if (status !== 'PENDING') continue;

    // PENDING without prepared_at is the hard order barrier. A later prepared
    // item may wait behind it but can never appear first in Telegram.
    if (!item.immediate_prepared_at) break;

    const result = await sendPreparedPreviewOnce(item.id, chatId);
    if (result?.sent) sent.push(item.id);
    if (result?.busy || result?.paused || result?.stale_profile) break;
  }

  return sent;
}

async function auditSentItems(itemIds, chatId) {
  const ids = [...new Set(itemIds.map(String))];
  for (let i = 0; i < ids.length; i += IMMEDIATE_MEDIA_AUDIT_CONCURRENCY) {
    const slice = ids.slice(i, i + IMMEDIATE_MEDIA_AUDIT_CONCURRENCY);
    await Promise.all(slice.map((id) => auditSentPreview(id, chatId).catch((error) => {
      console.error('Post-send recaption audit failed:', id, error?.message || error);
    })));
  }
}

async function auditSentPreview(itemId, chatId) {
  let item = await getQueueItem(itemId);
  if (!item?.preview_message_id) return null;
  const profile = await getProfileForItem(item);
  if (!profile) return null;

  let validation = validatePreparedItem(item, profile);
  if (validation.ok) {
    return updateQueueItem(item.id, {
      immediate_audit_at: new Date().toISOString(),
      error_message: null,
    });
  }

  // If another edit landed while the audit was starting, validate the newest
  // version before attempting repair so an older audit cannot overwrite it.
  const firstUpdatedAt = String(item.updated_at || '');
  const latest = await getQueueItem(item.id);
  if (!latest) return null;
  if (String(latest.updated_at || '') !== firstUpdatedAt) {
    const latestValidation = validatePreparedItem(latest, profile);
    if (latestValidation.ok) {
      return updateQueueItem(latest.id, {
        immediate_audit_at: new Date().toISOString(),
        error_message: null,
      });
    }
    item = latest;
    validation = latestValidation;
  }

  await recaptionItemWithProfile(item.id, profile, {
    reason: 'post_send_audit_repair',
    syncSent: false,
    forceTranslateAllLanguages: true,
  });
  if (item.media_kind === 'photo') {
    await withVisionSlot(() => maybeAutoNameUntitledDocument({
      itemId: item.id,
      chatId,
    }));
  }

  const repaired = await getQueueItem(item.id);
  if (!repaired) throw new Error('Audit repair item hilang');
  const repairedValidation = validatePreparedItem(repaired, profile);
  if (!repairedValidation.ok) {
    throw new Error(`Post-send audit repair still invalid: ${repairedValidation.errors.join('; ')}`);
  }

  await telegram('editMessageCaption', {
    chat_id: chatId,
    message_id: repaired.preview_message_id,
    caption: repaired.final_caption_html || '',
    parse_mode: 'HTML',
    reply_markup: inlineKeyboard(compactPreviewRows(repaired.id)),
  }).catch((error) => {
    if (!/message is not modified/i.test(String(error?.message || error))) throw error;
  });

  return updateQueueItem(repaired.id, {
    immediate_audit_at: new Date().toISOString(),
    error_message: null,
  });
}

async function takeImmediateWave(items) {
  const wave = [];

  for (const item of items) {
    if (wave.length >= IMMEDIATE_MEDIA_MAX_ITEMS_PER_INVOCATION) break;

    let needsReview = false;
    try {
      const resolved = await resolveFormatProfile({
        caption: item.original_caption || '',
        fileName: item.file_name || '',
        mediaKind: item.media_kind || 'other',
      });
      const confirmed = resolved.profile?.id
        ? await getSetting(`format_profile_confirmed:${resolved.profile.id}`).catch(() => null)
        : null;
      needsReview = Boolean(
        resolved.isNew
        || !resolved.profile
        || (!resolved.profile.learned && !confirmed?.confirmed),
      );
    } catch (error) {
      console.error('Immediate media preflight failed:', item?.id, error?.message || error);
      needsReview = true;
    }

    // A new/unconfirmed format is a hard boundary. If known items are already
    // in this wave, leave the boundary item for the next invocation. If it is
    // first, run it alone so it can raise the normal format-review gate.
    if (needsReview) {
      if (!wave.length) wave.push(item);
      break;
    }

    wave.push(item);
  }

  return wave;
}

async function listImmediatePending(chatId) {
  const rows = await listImmediateRows(chatId);
  return rows.filter((row) => (
    String(row.status || '').toUpperCase() === 'PENDING'
    && !row.immediate_prepared_at
  ));
}

async function listImmediateRows(chatId) {
  const [rows, floor] = await Promise.all([
    listQueueItems(chatId, 1000),
    getSetting(floorKey(chatId)).catch(() => null),
  ]);
  const floorAt = Date.parse(floor?.at || floor || 0);

  return (rows || [])
    .filter((row) => String(row.admin_chat_id) === String(chatId))
    .filter((row) => String(row.source_chat_id) === String(chatId))
    .filter((row) => !row.recaption_session_id)
    .filter((row) => ['PENDING', 'READY', 'FAILED'].includes(String(row.status || '').toUpperCase()))
    .filter((row) => {
      if (!Number.isFinite(floorAt)) return true;
      const created = Date.parse(row.created_at || 0);
      return Number.isFinite(created) && created >= floorAt;
    })
    .sort((a, b) => {
      const byMessage = Number(a.source_message_id) - Number(b.source_message_id);
      if (Number.isFinite(byMessage) && byMessage !== 0) return byMessage;
      return Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
    });
}

async function immediateQueueState(chatId) {
  const rows = await listImmediateRows(chatId);
  let remaining = 0;
  let blocked = false;

  for (const row of rows) {
    if (row.preview_message_id) continue;
    const status = String(row.status || '').toUpperCase();
    if (status === 'FAILED') {
      blocked = true;
      remaining += 1;
      continue;
    }
    if (status === 'PENDING') remaining += 1;
  }

  return {
    hasWork: remaining > 0,
    remaining,
    blocked,
  };
}

async function ensureImmediateQueueFloor(chatId) {
  const key = floorKey(chatId);
  const existing = await getSetting(key).catch(() => null);
  if (existing?.at || typeof existing === 'string') return existing;
  const value = { at: new Date(Date.now() - 60_000).toISOString() };
  await setSetting(key, value);
  return value;
}

async function ensureImmediateWorkerToken(chatId) {
  const key = tokenKey(chatId);
  const existing = await getSetting(key).catch(() => null);
  if (typeof existing === 'string' && existing.trim()) return existing.trim();
  const token = randomUUID();
  await setSetting(key, token);
  const confirmed = await getSetting(key).catch(() => token);
  return typeof confirmed === 'string' && confirmed.trim() ? confirmed.trim() : token;
}

async function claimImmediateMediaWorker(chatId, leaseToken) {
  const result = await supabaseRpc('claim_immediate_media_worker', {
    p_admin_chat_id: Number(chatId),
    p_lease_token: String(leaseToken),
    p_lease_seconds: 180,
  });
  return result === true;
}

async function releaseImmediateMediaWorker(chatId, leaseToken) {
  return supabaseRpc('release_immediate_media_worker', {
    p_admin_chat_id: Number(chatId),
    p_lease_token: String(leaseToken),
  });
}

async function supabaseRpc(name, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured');

  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase RPC ${name} ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function notifyQueuedBehindFormatGate(chatId) {
  const key = `${FORMAT_NOTICE_PREFIX}${chatId}`;
  const now = Date.now();
  const old = await getSetting(key).catch(() => null);
  const previous = Date.parse(old?.at || 0);
  const count = Number(old?.count || 0) + 1;
  await setSetting(key, { count, at: new Date().toISOString() }).catch(() => {});

  if (!Number.isFinite(previous) || now - previous > 5000) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: '⏸ Format review tengah pause. File baru aku simpan dalam queue dulu; aku tak recaption sampai format confirm + /resume.',
    }).catch(() => {});
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
