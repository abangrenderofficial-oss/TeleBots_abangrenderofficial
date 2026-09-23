import { randomUUID } from 'node:crypto';
import { getFormatProfile } from '../../format-profiles.js';
import { getQueueItem, getSetting, setSetting, updateQueueItem } from '../../store.js';
import { telegram, inlineKeyboard } from '../../telegram.js';
import { compactPreviewRows } from './preview-ui.js';
import { recaptionItemWithProfile } from './recaption.js';
import {
  getLatestRecaptionSession,
  getRecaptionSession,
  listRecaptionSessionItems,
} from './recaption-collection.js';

const WORKER_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/recaption-worker';
const JOB_PREFIX = 'format_batch_apply_v1:';
const ITEM_CONTEXT_PREFIX = 'format_item_v1:';
const MAX_ITEMS_PER_INVOCATION = 3;
const MAX_WORK_MS = 8_500;
const RUNNING_JOB_STALE_MS = 15 * 60 * 1000;

export async function startFormatBatchApply({ chatId, profileId }) {
  const profile = await getFormatProfile(profileId);
  if (!profile) return { ok: false, reason: 'profile_missing' };

  const session = await getLatestRecaptionSession(chatId, [
    'PROCESSING',
    'PAUSED',
    'FAILED',
    'COMPLETED',
  ]);
  if (!session) return { ok: false, reason: 'no_session', profile };

  const sessionStatus = String(session.status || '').toUpperCase();
  if (sessionStatus === 'PROCESSING') {
    return { ok: false, reason: 'session_processing', profile, session };
  }

  const jobKey = jobKeyForChat(chatId);
  const existing = await getSetting(jobKey).catch(() => null);
  if (existing?.status === 'RUNNING') {
    const age = Date.now() - Date.parse(existing.updated_at || existing.created_at || 0);
    if (Number.isFinite(age) && age >= 0 && age < RUNNING_JOB_STALE_MS) {
      return { ok: true, already_running: true, profile, session, job: existing };
    }
  }

  const items = await listRecaptionSessionItems(
    chatId,
    session.id,
    ['PENDING', 'READY', 'FAILED'],
    1000,
  );
  const contexts = await listRecentItemContexts();
  const profileByItem = new Map();
  for (const row of contexts) {
    const itemId = String(row?.key || '').slice(ITEM_CONTEXT_PREFIX.length);
    const mappedProfileId = String(row?.value?.profile_id || '');
    if (itemId && mappedProfileId) profileByItem.set(itemId, mappedProfileId);
  }

  const selected = items.filter((item) => (
    profileByItem.get(String(item.id)) === String(profileId)
  ));
  const unassignedCount = items.filter((item) => !profileByItem.has(String(item.id))).length;

  if (!selected.length) {
    return {
      ok: true,
      started: false,
      reason: 'no_matching_unsent_items',
      profile,
      session,
      matched: 0,
      unassigned: unassignedCount,
    };
  }

  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    status: 'RUNNING',
    chat_id: Number(chatId),
    session_id: String(session.id),
    profile_id: String(profileId),
    profile_name: profile.name,
    item_ids: selected.map((item) => String(item.id)),
    next_index: 0,
    updated_count: 0,
    failed_count: 0,
    skipped_count: 0,
    unassigned_count: unassignedCount,
    created_at: now,
    updated_at: now,
  };
  await setSetting(jobKey, job);

  return {
    ok: true,
    started: true,
    profile,
    session,
    job,
    matched: job.item_ids.length,
    unassigned: unassignedCount,
  };
}

export async function kickFormatBatchApply({ sessionId, workerSecret, jobId }) {
  if (!sessionId || !workerSecret || !jobId) throw new Error('Format batch worker credentials tak lengkap');
  const response = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'apply_profile',
      session_id: sessionId,
      worker_secret: workerSecret,
      job_id: jobId,
    }),
  });
  if (!response.ok) throw new Error(`Format batch worker kick HTTP ${response.status}`);
  return response.json().catch(() => ({ ok: true }));
}

export async function runFormatBatchApplyJob({ sessionId, workerSecret, jobId }) {
  const session = await getRecaptionSession(sessionId);
  if (!session || String(session.worker_secret || '') !== String(workerSecret || '')) {
    return { ok: false, status_code: 403, error: 'invalid session credentials' };
  }

  const chatId = session.admin_chat_id;
  const jobKey = jobKeyForChat(chatId);
  let job = await getSetting(jobKey).catch(() => null);
  if (!job || String(job.id) !== String(jobId) || String(job.session_id) !== String(sessionId)) {
    return { ok: false, status_code: 404, error: 'format batch job not found' };
  }
  if (job.status !== 'RUNNING') {
    return { ok: true, done: true, status: job.status, job_id: job.id };
  }

  const liveSessionStatus = String(session.status || '').toUpperCase();
  if (liveSessionStatus === 'PROCESSING' || liveSessionStatus === 'COLLECTING') {
    job = await saveJob(jobKey, job, {
      status: 'BLOCKED',
      blocked_reason: 'recaption_session_running',
    });
    await telegram('sendMessage', {
      chat_id: chatId,
      text: `⏸ APPLY CURRENT BATCH dihentikan sebab RECAPTION session ${liveSessionStatus}. Tekan APPLY semula bila session dah PAUSED/COMPLETED/FAILED.`,
    }).catch(() => {});
    return { ok: true, done: true, status: job.status, job_id: job.id };
  }

  const profile = await getFormatProfile(job.profile_id);
  if (!profile) {
    job = await saveJob(jobKey, job, { status: 'FAILED', error: 'format profile missing' });
    return { ok: false, done: true, status: job.status, job_id: job.id, error: job.error };
  }

  const startedAt = Date.now();
  let processedThisRun = 0;
  let nextIndex = Math.max(0, Number(job.next_index || 0));
  let updatedCount = Math.max(0, Number(job.updated_count || 0));
  let failedCount = Math.max(0, Number(job.failed_count || 0));
  let skippedCount = Math.max(0, Number(job.skipped_count || 0));
  const ids = Array.isArray(job.item_ids) ? job.item_ids : [];

  while (nextIndex < ids.length) {
    if (processedThisRun >= MAX_ITEMS_PER_INVOCATION) break;
    if (Date.now() - startedAt >= MAX_WORK_MS) break;

    const itemId = String(ids[nextIndex]);
    try {
      const item = await getQueueItem(itemId);
      const status = String(item?.status || '').toUpperCase();
      if (!item || ['SENT', 'SKIPPED'].includes(status)) {
        skippedCount += 1;
      } else {
        const result = await recaptionItemWithProfile(item.id, profile, {
          reason: 'format_manager_apply_current_batch',
          syncSent: false,
        });
        await syncUnsentPreview(result.item, chatId);
        updatedCount += 1;
      }
    } catch (error) {
      failedCount += 1;
      const message = String(error?.message || error).slice(0, 900);
      await updateQueueItem(itemId, {
        status: 'FAILED',
        error_message: `APPLY CURRENT BATCH: ${message}`,
      }).catch(() => {});
      console.error('Format batch apply item failed:', itemId, message);
    }

    nextIndex += 1;
    processedThisRun += 1;
    job = await saveJob(jobKey, job, {
      next_index: nextIndex,
      updated_count: updatedCount,
      failed_count: failedCount,
      skipped_count: skippedCount,
    });
  }

  if (nextIndex >= ids.length) {
    job = await saveJob(jobKey, job, {
      status: failedCount ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
      completed_at: new Date().toISOString(),
      next_index: nextIndex,
      updated_count: updatedCount,
      failed_count: failedCount,
      skipped_count: skippedCount,
    });
    await telegram('sendMessage', {
      chat_id: chatId,
      text: [
        `✅ APPLY CURRENT BATCH siap untuk ${profile.name}.`,
        `${updatedCount} updated · ${failedCount} failed · ${skippedCount} skipped.`,
        job.unassigned_count
          ? `${job.unassigned_count} item yang belum ada format context tak disentuh; bila /resume, ia akan guna setting format terbaru secara normal.`
          : 'Semua item matching yang belum SENT dah diperiksa.',
        'Item SENT lama memang tak disentuh.',
      ].join('\n'),
    }).catch(() => {});
    return {
      ok: failedCount === 0,
      done: true,
      status: job.status,
      job_id: job.id,
      updated: updatedCount,
      failed: failedCount,
      skipped: skippedCount,
    };
  }

  return {
    ok: true,
    done: false,
    should_continue: true,
    job_id: job.id,
    session_id: session.id,
    processed: processedThisRun,
    next_index: nextIndex,
    total: ids.length,
  };
}

async function syncUnsentPreview(item, chatId) {
  if (!item?.preview_message_id) return;
  if (String(item.status || '').toUpperCase() === 'SENT') return;
  await telegram('editMessageCaption', {
    chat_id: chatId,
    message_id: item.preview_message_id,
    caption: item.final_caption_html || '',
    parse_mode: 'HTML',
    reply_markup: inlineKeyboard(compactPreviewRows(item.id)),
  }).catch((error) => {
    console.error('Format batch preview sync failed:', item.id, error?.message || error);
  });
}

async function saveJob(key, current, patch) {
  const next = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await setSetting(key, next);
  return next;
}

function jobKeyForChat(chatId) {
  return `${JOB_PREFIX}${chatId}`;
}

async function listRecentItemContexts() {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!base || !key) throw new Error('Supabase is not configured');
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    accept: 'application/json',
  };
  const like = encodeURIComponent(`${ITEM_CONTEXT_PREFIX}*`);
  const response = await fetch(
    `${base}/rest/v1/bot_settings?key=like.${like}&order=updated_at.desc&limit=1000&select=key,value`,
    { headers },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Format context scan ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}
