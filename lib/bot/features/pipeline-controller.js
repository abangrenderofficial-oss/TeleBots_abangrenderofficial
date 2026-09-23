import {
  getSetting,
  listQueueItems,
  setSetting,
  updateQueueItem,
} from '../../store.js';

const PIPELINE_PREFIX = 'pipeline_control_v1:';
const IMMEDIATE_PAUSE_PREFIX = 'immediate_media_pause:';
const DIRECT_AI_BYPASS_PREFIX = 'direct_ai_bypass_v1:';
const PROFILE_REVISION_PREFIX = 'format_profile_revision_v1:';
const PREPARED_REVISION_PREFIX = 'immediate_prepared_revision_v1:';
const ITEM_CONTEXT_PREFIX = 'format_item_v1:';

export const PIPELINE_REASONS = Object.freeze({
  MANUAL_STOP: 'MANUAL_STOP',
  NEW_FORMAT: 'NEW_FORMAT',
  AI_LIMIT: 'AI_LIMIT',
  FORMAT_EDIT: 'FORMAT_EDIT',
  MAINTENANCE: 'MAINTENANCE',
});

function pipelineKey(chatId) {
  return `${PIPELINE_PREFIX}${chatId}`;
}

function immediatePauseKey(chatId) {
  return `${IMMEDIATE_PAUSE_PREFIX}${chatId}`;
}

function directAiBypassKey(chatId) {
  return `${DIRECT_AI_BYPASS_PREFIX}${chatId}`;
}

function profileRevisionKey(profileId) {
  return `${PROFILE_REVISION_PREFIX}${profileId}`;
}

function preparedRevisionKey(itemId) {
  return `${PREPARED_REVISION_PREFIX}${itemId}`;
}

export async function getPipelineState(chatId) {
  const value = await getSetting(pipelineKey(chatId)).catch(() => null);
  return value?.paused ? value : null;
}

export async function isPipelinePaused(chatId) {
  return Boolean(await getPipelineState(chatId));
}

export async function pausePipeline({
  chatId,
  reason,
  itemId = null,
  sessionId = null,
  profileId = null,
  scope = 'global',
  meta = null,
}) {
  const now = new Date().toISOString();
  const current = await getPipelineState(chatId);

  // Never let a lower-priority transient pause overwrite a safety-critical gate.
  // NEW_FORMAT and MANUAL_STOP always win until an explicit resume path clears them.
  if (
    current?.paused
    && [PIPELINE_REASONS.NEW_FORMAT, PIPELINE_REASONS.MANUAL_STOP].includes(current.reason)
    && current.reason !== reason
  ) {
    return current;
  }

  const state = {
    paused: true,
    reason: String(reason || PIPELINE_REASONS.MAINTENANCE),
    scope,
    item_id: itemId != null ? String(itemId) : null,
    session_id: sessionId != null ? String(sessionId) : null,
    profile_id: profileId != null ? String(profileId) : null,
    meta: meta || null,
    paused_at: current?.paused_at || now,
    updated_at: now,
  };

  await Promise.all([
    setSetting(pipelineKey(chatId), state),
    setSetting(immediatePauseKey(chatId), {
      paused: true,
      reason: state.reason,
      item_id: state.item_id,
      session_id: state.session_id,
      profile_id: state.profile_id,
      paused_at: state.paused_at,
      updated_at: now,
    }),
  ]);

  return state;
}

export async function resumePipeline(chatId, options = {}) {
  const current = await getPipelineState(chatId);
  if (!current) {
    await clearImmediatePause(chatId);
    return { ok: true, resumed: false, reason: 'not_paused' };
  }

  const allowed = Array.isArray(options.allowedReasons)
    ? options.allowedReasons.map(String)
    : null;
  if (allowed?.length && !allowed.includes(String(current.reason))) {
    return { ok: false, resumed: false, blocked_reason: current.reason, state: current };
  }

  const now = new Date().toISOString();
  await Promise.all([
    setSetting(pipelineKey(chatId), {
      ...current,
      paused: false,
      resumed_at: now,
      updated_at: now,
    }),
    clearImmediatePause(chatId),
  ]);

  return { ok: true, resumed: true, previous: current };
}

export async function clearImmediatePause(chatId) {
  return setSetting(immediatePauseKey(chatId), {
    paused: false,
    resumed_at: new Date().toISOString(),
  });
}

export async function setDirectAiBypass(chatId, itemId, enabled = true) {
  const value = enabled
    ? {
      enabled: true,
      item_id: String(itemId || ''),
      enabled_at: new Date().toISOString(),
    }
    : {
      enabled: false,
      item_id: null,
      cleared_at: new Date().toISOString(),
    };
  await setSetting(directAiBypassKey(chatId), value);
  return value;
}

export async function isDirectAiBypass(chatId, itemId) {
  const value = await getSetting(directAiBypassKey(chatId)).catch(() => null);
  return Boolean(
    value?.enabled
    && String(value.item_id || '') === String(itemId || ''),
  );
}

export async function clearDirectAiBypass(chatId, itemId = null) {
  const value = await getSetting(directAiBypassKey(chatId)).catch(() => null);
  if (!value?.enabled) return false;
  if (itemId != null && String(value.item_id || '') !== String(itemId)) return false;
  await setDirectAiBypass(chatId, null, false);
  return true;
}

export async function getFormatProfileRevision(profileId) {
  const value = await getSetting(profileRevisionKey(profileId)).catch(() => null);
  const revision = Number(value?.revision ?? value ?? 1);
  return Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 1;
}

export async function markFormatProfileChanged({ chatId, profileId }) {
  if (!profileId) return { revision: 1, invalidated: 0 };
  const current = await getFormatProfileRevision(profileId);
  const revision = current + 1;
  await setSetting(profileRevisionKey(profileId), {
    revision,
    updated_at: new Date().toISOString(),
  });

  const invalidated = chatId != null
    ? await invalidatePreparedItemsForProfile(chatId, profileId)
    : 0;
  return { revision, invalidated };
}

export async function stampPreparedProfileRevision(itemId, profileId) {
  const revision = await getFormatProfileRevision(profileId);
  await setSetting(preparedRevisionKey(itemId), {
    profile_id: String(profileId || ''),
    revision,
    prepared_at: new Date().toISOString(),
  });
  return revision;
}

export async function preparedProfileRevisionIsCurrent(itemId, profileId) {
  const [prepared, current] = await Promise.all([
    getSetting(preparedRevisionKey(itemId)).catch(() => null),
    getFormatProfileRevision(profileId),
  ]);
  return Boolean(
    prepared
    && String(prepared.profile_id || '') === String(profileId || '')
    && Number(prepared.revision) === Number(current),
  );
}

export async function clearPreparedProfileRevision(itemId) {
  return setSetting(preparedRevisionKey(itemId), null);
}

export async function invalidatePreparedItemsForProfile(chatId, profileId) {
  const rows = await listQueueItems(chatId, 1000).catch(() => []);
  let invalidated = 0;

  for (const item of rows || []) {
    if (item.preview_message_id) continue;
    if (!item.immediate_prepared_at) continue;
    if (String(item.status || '').toUpperCase() !== 'PENDING') continue;

    const context = await getSetting(`${ITEM_CONTEXT_PREFIX}${item.id}`).catch(() => null);
    if (String(context?.profile_id || '') !== String(profileId)) continue;

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
    invalidated += 1;
  }

  return invalidated;
}
