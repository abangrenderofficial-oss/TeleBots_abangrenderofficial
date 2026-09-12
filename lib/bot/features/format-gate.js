import { stopAllRunningBatches } from '../../explicit-batches.js';
import { getQueueItem, getSetting, setSetting, updateQueueItem } from '../../store.js';

const REVIEW_PREFIX = 'format_review_gate:';
const PROFILE_KEY = 'format_profiles_v1';

function reviewKey(chatId) {
  return `${REVIEW_PREFIX}${chatId}`;
}

export async function getFormatReview(chatId) {
  const value = await getSetting(reviewKey(chatId)).catch(() => null);
  return value?.paused ? value : null;
}

export async function isFormatPipelinePaused(chatId) {
  return Boolean(await getFormatReview(chatId));
}

export async function pauseForNewFormat({ chatId, itemId, profileId, signature = null }) {
  const now = new Date().toISOString();
  const current = await getFormatReview(chatId);

  // First unfamiliar format owns the gate. A later concurrent webhook is not
  // allowed to replace the format the owner is already reviewing.
  if (current?.paused) return current;

  const review = {
    paused: true,
    confirmed: false,
    confirm_stage: 0,
    item_id: String(itemId),
    profile_id: String(profileId),
    signature: signature || null,
    created_at: now,
    updated_at: now,
  };

  await setSetting(reviewKey(chatId), review);
  await setSetting(`send_paused:${chatId}`, {
    paused: true,
    hard_stop: true,
    reason: 'new_format_review',
    format_item_id: String(itemId),
    format_profile_id: String(profileId),
    paused_at: now,
  });
  await stopAllRunningBatches(chatId).catch(() => []);
  return review;
}

export async function confirmFormatStep({ chatId, itemId }) {
  const review = await getFormatReview(chatId);
  if (!review || String(review.item_id) !== String(itemId)) {
    return { ok: false, reason: 'no_matching_review' };
  }

  if (review.confirmed) {
    return { ok: true, confirmed: true, stage: 2, review };
  }

  if (Number(review.confirm_stage || 0) < 1) {
    const next = {
      ...review,
      confirm_stage: 1,
      updated_at: new Date().toISOString(),
    };
    await setSetting(reviewKey(chatId), next);
    return { ok: true, confirmed: false, stage: 1, review: next };
  }

  const profile = await confirmStoredProfile(review.profile_id);
  if (!profile) return { ok: false, reason: 'profile_missing' };

  const item = await getQueueItem(review.item_id);
  if (item && !['SENT', 'SKIPPED'].includes(String(item.status || '').toUpperCase())) {
    await updateQueueItem(item.id, {
      status: 'READY',
      error_message: null,
    });
  }

  const confirmed = {
    ...review,
    confirmed: true,
    confirm_stage: 2,
    confirmed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await setSetting(reviewKey(chatId), confirmed);
  return { ok: true, confirmed: true, stage: 2, review: confirmed, profile };
}

export async function releaseConfirmedFormatReview(chatId) {
  const review = await getFormatReview(chatId);
  if (!review) return { ok: true, released: false, reason: 'no_review' };
  if (!review.confirmed) return { ok: false, released: false, reason: 'not_confirmed', review };

  await setSetting(reviewKey(chatId), null);
  return { ok: true, released: true, review };
}

export async function restoreFormatReview(chatId, review) {
  if (!review) return setSetting(reviewKey(chatId), null);
  return setSetting(reviewKey(chatId), {
    ...review,
    paused: true,
    updated_at: new Date().toISOString(),
  });
}

export function formatConfirmLabel(review, itemId) {
  if (!review || String(review.item_id) !== String(itemId)) return null;
  if (review.confirmed) return '✅ FORMAT CONFIRMED · /resume';
  if (Number(review.confirm_stage || 0) >= 1) return '✅ CONFIRM SEKALI LAGI';
  return '✅ CONFIRM FORMAT';
}

async function confirmStoredProfile(profileId) {
  const profiles = await getSetting(PROFILE_KEY).catch(() => null);
  if (!Array.isArray(profiles)) return null;
  const index = profiles.findIndex((profile) => String(profile?.id) === String(profileId));
  if (index < 0) return null;

  const now = new Date().toISOString();
  const profile = {
    ...profiles[index],
    learned: true,
    confirmed_at: now,
    updated_at: now,
  };
  profiles[index] = profile;
  await setSetting(PROFILE_KEY, profiles.slice(-120));
  return profile;
}
