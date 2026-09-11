import { getQueueItem, getSetting, listQueueItems, setSetting } from './store.js';

const SEND_BATCH_GAP_MS = 2 * 60 * 1000;

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

  const rows = await listQueueItems(chatId, 500);
  const ordered = (rows || [])
    .filter((row) => String(row.admin_chat_id) === String(chatId))
    .filter((row) => String(row.source_chat_id) === String(anchor.source_chat_id))
    .filter((row) => Number(row.source_message_id) >= Number(anchor.source_message_id))
    .sort((a, b) => {
      const byMessage = Number(a.source_message_id) - Number(b.source_message_id);
      if (Number.isFinite(byMessage) && byMessage !== 0) return byMessage;
      return Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
    });

  const out = [];
  let previousAt = null;
  for (const row of ordered) {
    const createdAt = Date.parse(row.created_at || 0);
    if (previousAt != null && Number.isFinite(createdAt) && Number.isFinite(previousAt)) {
      if (createdAt - previousAt > SEND_BATCH_GAP_MS) break;
    }
    previousAt = createdAt;

    if (['READY', 'FAILED', 'SENT'].includes(String(row.status || '').toUpperCase())) {
      out.push(row);
    }
  }

  return out;
}
