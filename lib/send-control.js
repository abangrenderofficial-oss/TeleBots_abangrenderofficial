import { getQueueItem, getSetting, setSetting } from './store.js';

const SEND_BATCH_GAP_MS = 2 * 60 * 1000;
const RESEND_QUERY_LIMIT = 500;
const MAX_SOURCE_MESSAGE_GAP = 50;

function pauseKey(chatId) {
  return `send_paused:${chatId}`;
}

function batchKey(chatId) {
  return `active_send_batch:${chatId}`;
}

export async function isSendPaused(chatId) {
  const value = await getSetting(pauseKey(chatId)).catch(() => null);
  return Boolean(value === true || value?.paused);
}

export async function pauseSending(chatId) {
  await setSetting(pauseKey(chatId), {
    paused: true,
    paused_at: new Date().toISOString(),
  });
  return getActiveSendBatch(chatId);
}

export async function resumeSending(chatId) {
  await setSetting(pauseKey(chatId), {
    paused: false,
    resumed_at: new Date().toISOString(),
  });
  return getActiveSendBatch(chatId);
}

export async function getActiveSendBatch(chatId) {
  return getSetting(batchKey(chatId)).catch(() => null);
}

export async function startActiveSendBatch(chatId, items, mode = 'normal') {
  const batch = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    mode,
    item_ids: (items || []).map((item) => item.id).filter(Boolean),
    next_index: 0,
    sent: 0,
    failed: 0,
    completed: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await setSetting(batchKey(chatId), batch);
  return batch;
}

export async function saveActiveSendBatch(chatId, batch) {
  const next = {
    ...batch,
    updated_at: new Date().toISOString(),
  };
  await setSetting(batchKey(chatId), next);
  return next;
}

export async function finishActiveSendBatch(chatId, batch) {
  return saveActiveSendBatch(chatId, {
    ...batch,
    next_index: Array.isArray(batch?.item_ids) ? batch.item_ids.length : 0,
    completed: true,
    completed_at: new Date().toISOString(),
  });
}

export async function buildResendBatchItems(chatId, anchorItemId) {
  const anchor = await getQueueItem(anchorItemId);
  if (!anchor) return [];

  // IMPORTANT: query FROM the clicked source message at the database level.
  // The old implementation first loaded only the latest 500 queue rows and
  // then filtered in memory. For an old preview, the anchor itself could be
  // outside that 500-row window, causing RESEND ALL to jump forward into an
  // unrelated newer upload session. Anchoring the REST query prevents that.
  const rows = await listResendCandidatesFromAnchor(chatId, anchor);
  return selectResendBatchWindow(rows, anchor);
}

export function selectResendBatchWindow(rows, anchor) {
  if (!anchor) return [];

  const adminChatId = String(anchor.admin_chat_id);
  const sourceChatId = String(anchor.source_chat_id);
  const anchorSourceId = Number(anchor.source_message_id);
  const anchorId = String(anchor.id || '');
  if (!Number.isFinite(anchorSourceId) || !anchorId) return [];

  const ordered = (rows || [])
    .filter((row) => String(row.admin_chat_id) === adminChatId)
    .filter((row) => String(row.source_chat_id) === sourceChatId)
    .filter((row) => Number(row.source_message_id) >= anchorSourceId)
    .sort((a, b) => {
      const byMessage = Number(a.source_message_id) - Number(b.source_message_id);
      if (Number.isFinite(byMessage) && byMessage !== 0) return byMessage;
      return Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
    });

  // Never silently start from a later row if the exact clicked anchor is not
  // present. Returning [] is safer than sending the wrong batch.
  const startIndex = ordered.findIndex((row) => String(row.id) === anchorId);
  if (startIndex < 0) return [];

  const out = [];
  const seenSourceIds = new Set();
  let previousAt = null;
  let previousSourceId = null;

  for (const row of ordered.slice(startIndex)) {
    const sourceId = Number(row.source_message_id);
    const createdAt = Date.parse(row.created_at || 0);
    if (!Number.isFinite(sourceId)) break;

    // Duplicate queue rows for one Telegram source message must not create two
    // sends in one explicit resend batch.
    if (seenSourceIds.has(sourceId)) continue;

    if (previousSourceId != null) {
      const sourceGap = sourceId - previousSourceId;
      if (sourceGap < 0 || sourceGap > MAX_SOURCE_MESSAGE_GAP) break;

      if (Number.isFinite(createdAt) && Number.isFinite(previousAt)) {
        // created_at must move forward inside one upload session. A backwards
        // timestamp indicates a different/reprocessed window, so fail closed.
        if (createdAt < previousAt) break;
        if (createdAt - previousAt > SEND_BATCH_GAP_MS) break;
      }
    }

    seenSourceIds.add(sourceId);
    previousSourceId = sourceId;
    if (Number.isFinite(createdAt)) previousAt = createdAt;

    if (['READY', 'FAILED', 'SENT'].includes(String(row.status || '').toUpperCase())) {
      out.push(row);
    }
  }

  return out;
}

async function listResendCandidatesFromAnchor(chatId, anchor) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Supabase is not configured');

  const params = new URLSearchParams({
    admin_chat_id: `eq.${String(chatId)}`,
    source_chat_id: `eq.${String(anchor.source_chat_id)}`,
    source_message_id: `gte.${String(anchor.source_message_id)}`,
    order: 'source_message_id.asc,created_at.asc',
    limit: String(RESEND_QUERY_LIMIT),
    select: '*',
  });

  const response = await fetch(`${base}/rest/v1/queue_items?${params.toString()}`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase resend source error ${response.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}
