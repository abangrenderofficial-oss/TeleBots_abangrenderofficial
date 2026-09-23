import { randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { duplicateNotice, inspectIncomingDuplicate } from '../../duplicates.js';
import {
  rememberUntitledMediaContext,
} from '../../untitled-namer.js';
import {
  getProfileForItem,
  resolveFormatProfile,
} from '../../format-profiles.js';
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
import { compactPreviewRows } from './preview-ui.js';
import { recaptionItemWithProfile } from './recaption.js';

export const IMMEDIATE_MEDIA_CONCURRENCY = 3;
export const IMMEDIATE_MEDIA_MAX_ITEMS_PER_INVOCATION = 3;
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
    return { ok: true, queued: true, blocked: 'maintenance_pause', item_id: item.id };
  }

  // Return the Telegram webhook quickly. The heavy caption/vision work runs in
  // the existing recaption worker endpoint, where one DB lease owns the queue.
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

    const pending = await listImmediatePending(chatId);
    if (!pending.length) {
      return { ok: true, done: true, processed: 0, remaining: 0, chat_id: String(chatId) };
    }

    const wave = await takeImmediateWave(pending);
    if (!wave.length) {
      return { ok: true, done: false, processed: 0, remaining: pending.length, should_continue: false, chat_id: String(chatId) };
    }

    const results = await Promise.all(wave.map(async (item) => {
      try {
        const result = await processPendingItem(item, {
          resumed: true,
          immediateWorker: true,
        });

        if (result?.ready) {
          await finalizeImmediateMediaItem(item.id, chatId);
        }

        return { item, result };
      } catch (error) {
        const errorText = String(error?.message || error).slice(0, 1000);
        const current = await getQueueItem(item.id).catch(() => null);

        // Strict fail-closed behavior: an untranslated foreign title must not
        // remain READY merely because the fast preview stage succeeded first.
        await updateQueueItem(item.id, {
          status: 'FAILED',
          error_message: errorText,
        }).catch(() => {});

        if (
          current?.preview_message_id
          && /translation unavailable|translate failed|translation still contains non-latin|recaption validation failed/i.test(errorText)
        ) {
          await telegram('deleteMessage', {
            chat_id: chatId,
            message_id: current.preview_message_id,
          }).catch(() => {});
          await updateQueueItem(item.id, { preview_message_id: null }).catch(() => {});
        }

        return { item, error };
      }
    }));

    for (const entry of results) {
      if (entry.error) {
        console.error('Immediate media item failed:', entry.item?.id, entry.error?.message || entry.error);
      }
    }

    const formatPaused = await isFormatPipelinePaused(chatId);
    const maintenancePaused = await isImmediateMediaPaused(chatId);
    const remaining = await listImmediatePending(chatId);
    const shouldContinue = !formatPaused && !maintenancePaused && remaining.length > 0;

    return {
      ok: true,
      done: !remaining.length,
      processed: results.length,
      remaining: remaining.length,
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

async function finalizeImmediateMediaItem(itemId, chatId) {
  const item = await getQueueItem(itemId);
  if (!item) throw new Error('Immediate media item hilang masa final validation');

  const profile = await getProfileForItem(item);
  if (!profile?.actions?.translate && !profile?.actions?.take_serial) return item;

  // Reuse the same strict multi-provider translation + validation path used by
  // manual /recaption. This removes the old direct-path Gemini-only fallback.
  const result = await recaptionItemWithProfile(item.id, profile, {
    reason: 'immediate_media_final_validation',
    syncSent: false,
  });
  const updated = result.item;

  if (updated?.preview_message_id) {
    await telegram('editMessageCaption', {
      chat_id: chatId,
      message_id: updated.preview_message_id,
      caption: updated.final_caption_html || '',
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard(compactPreviewRows(updated.id)),
    }).catch((error) => {
      console.error('Immediate media final preview sync failed:', error?.message || error);
    });
  }

  return updated;
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
  const [rows, floor] = await Promise.all([
    listQueueItems(chatId, 1000),
    getSetting(floorKey(chatId)).catch(() => null),
  ]);
  const floorAt = Date.parse(floor?.at || floor || 0);

  return (rows || [])
    .filter((row) => String(row.admin_chat_id) === String(chatId))
    .filter((row) => String(row.source_chat_id) === String(chatId))
    .filter((row) => !row.recaption_session_id)
    .filter((row) => String(row.status || '').toUpperCase() === 'PENDING')
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
    p_lease_seconds: 45,
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
