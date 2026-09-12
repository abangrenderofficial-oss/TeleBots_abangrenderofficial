import { setSetting } from './store.js';

const apiBase = () => `${String(process.env.SUPABASE_URL || '').replace(/\/$/, '')}/rest/v1`;

function headers(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!process.env.SUPABASE_URL || !key) throw new Error('Supabase is not configured');
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    ...extra,
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: headers(options.headers || {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase batch error ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function idPart() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function newBatchId() {
  return `B${Date.now().toString(36).toUpperCase()}${idPart()}`;
}

function newWorkerSecret() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

export async function createExplicitBatch({ adminChatId, triggerId, mode, destinationChatId, items }) {
  const cleanItems = (items || []).filter((item) => item?.id);
  if (!cleanItems.length) throw new Error('Batch has no items');

  const id = newBatchId();
  const workerSecret = newWorkerSecret();
  const now = new Date().toISOString();
  const row = {
    id,
    admin_chat_id: String(adminChatId),
    trigger_id: String(triggerId),
    mode: mode === 'resend' ? 'resend' : 'normal',
    status: 'RUNNING',
    destination_chat_id: String(destinationChatId),
    item_ids: cleanItems.map((item) => String(item.id)),
    next_index: 0,
    sent_count: 0,
    failed_count: 0,
    worker_secret: workerSecret,
    created_at: now,
    updated_at: now,
  };

  const inserted = await request('/send_batches?on_conflict=trigger_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(row),
  });

  let batch = inserted?.[0] || null;
  const created = Boolean(batch);

  if (!batch) {
    batch = await getBatchByTrigger(triggerId);
    if (!batch) throw new Error('Unable to resolve duplicate batch trigger');
    return { batch, created: false };
  }

  const itemRows = cleanItems.map((item, position) => ({
    batch_id: batch.id,
    position,
    item_id: String(item.id),
    status: 'PENDING',
    attempts: 0,
    updated_at: now,
  }));

  await request('/send_batch_items?on_conflict=batch_id,position', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(itemRows),
  });

  await setSetting(`latest_explicit_batch:${adminChatId}`, {
    batch_id: batch.id,
    created_at: batch.created_at,
  }).catch(() => {});

  return { batch, created };
}

export async function getBatchByTrigger(triggerId) {
  const rows = await request(`/send_batches?trigger_id=eq.${encodeURIComponent(String(triggerId))}&select=*&limit=1`);
  return rows?.[0] || null;
}

export async function getBatch(batchId) {
  const rows = await request(`/send_batches?id=eq.${encodeURIComponent(String(batchId))}&select=*&limit=1`);
  return rows?.[0] || null;
}

export async function getLatestBatch(adminChatId) {
  const rows = await request(`/send_batches?admin_chat_id=eq.${encodeURIComponent(String(adminChatId))}&order=created_at.desc&select=*&limit=1`);
  return rows?.[0] || null;
}

export async function getRunningBatch(adminChatId) {
  const rows = await request(`/send_batches?admin_chat_id=eq.${encodeURIComponent(String(adminChatId))}&status=eq.RUNNING&order=created_at.desc&select=*&limit=1`);
  return rows?.[0] || null;
}

export async function stopAllRunningBatches(adminChatId) {
  const now = new Date().toISOString();
  const rows = await request(`/send_batches?admin_chat_id=eq.${encodeURIComponent(String(adminChatId))}&status=eq.RUNNING`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'STOPPED', stopped_at: now, updated_at: now }),
  });
  return rows || [];
}

export async function resumeBatch(batchId) {
  const now = new Date().toISOString();
  const rows = await request(`/send_batches?id=eq.${encodeURIComponent(String(batchId))}&status=eq.STOPPED`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'RUNNING', stopped_at: null, updated_at: now }),
  });
  return rows?.[0] || getBatch(batchId);
}

export async function recoverStaleClaims(batchId, staleMs = 120000) {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  return request(`/send_batch_items?batch_id=eq.${encodeURIComponent(String(batchId))}&status=eq.SENDING&started_at=lt.${encodeURIComponent(cutoff)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'PENDING',
      error_message: 'Recovered stale worker claim',
      started_at: null,
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function claimNextBatchItem(batchId) {
  const pending = await request(`/send_batch_items?batch_id=eq.${encodeURIComponent(String(batchId))}&status=eq.PENDING&order=position.asc&select=*&limit=1`);
  const candidate = pending?.[0];
  if (!candidate) return null;

  const now = new Date().toISOString();
  const rows = await request(`/send_batch_items?batch_id=eq.${encodeURIComponent(String(batchId))}&position=eq.${candidate.position}&status=eq.PENDING`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'SENDING',
      attempts: Number(candidate.attempts || 0) + 1,
      started_at: now,
      updated_at: now,
    }),
  });
  return rows?.[0] || null;
}

export async function requeueBatchItem(batchId, position) {
  const rows = await request(`/send_batch_items?batch_id=eq.${encodeURIComponent(String(batchId))}&position=eq.${Number(position)}&status=eq.SENDING`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'PENDING', started_at: null, updated_at: new Date().toISOString() }),
  });
  return rows?.[0] || null;
}

export async function markBatchItemSent(batchId, position, destinationMessageId) {
  const now = new Date().toISOString();
  const rows = await request(`/send_batch_items?batch_id=eq.${encodeURIComponent(String(batchId))}&position=eq.${Number(position)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'SENT',
      destination_message_id: Number(destinationMessageId),
      error_message: null,
      finished_at: now,
      updated_at: now,
    }),
  });
  return rows?.[0] || null;
}

export async function markBatchItemFailed(batchId, position, error) {
  const now = new Date().toISOString();
  const rows = await request(`/send_batch_items?batch_id=eq.${encodeURIComponent(String(batchId))}&position=eq.${Number(position)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'FAILED',
      error_message: String(error?.message || error).slice(0, 1000),
      finished_at: now,
      updated_at: now,
    }),
  });
  return rows?.[0] || null;
}

export async function markBatchItemSkipped(batchId, position, reason = 'Not eligible') {
  const now = new Date().toISOString();
  const rows = await request(`/send_batch_items?batch_id=eq.${encodeURIComponent(String(batchId))}&position=eq.${Number(position)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'SKIPPED',
      error_message: String(reason).slice(0, 1000),
      finished_at: now,
      updated_at: now,
    }),
  });
  return rows?.[0] || null;
}

export async function recordBatchMessage({ batchId, item, destinationChatId, destinationMessageId }) {
  const row = {
    batch_id: String(batchId),
    item_id: String(item.id),
    source_chat_id: item.source_chat_id != null ? String(item.source_chat_id) : null,
    source_message_id: item.source_message_id != null ? Number(item.source_message_id) : null,
    destination_chat_id: String(destinationChatId),
    destination_message_id: Number(destinationMessageId),
    sent_at: new Date().toISOString(),
  };

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await request('/send_batch_messages?on_conflict=batch_id,destination_message_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
      return true;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
  throw lastError || new Error('Unable to record batch message');
}

export async function getBatchMessages(batchId, { undeletedOnly = false } = {}) {
  const deletedFilter = undeletedOnly ? '&deleted_at=is.null' : '';
  return request(`/send_batch_messages?batch_id=eq.${encodeURIComponent(String(batchId))}${deletedFilter}&order=sent_at.asc&select=*`);
}

export async function markBatchMessagesDeleted(batchId, messageIds) {
  const ids = [...new Set((messageIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const rows = await request(`/send_batch_messages?batch_id=eq.${encodeURIComponent(String(batchId))}&destination_message_id=in.(${chunk.join(',')})`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        delete_status: 'DELETED',
        deleted_at: new Date().toISOString(),
      }),
    });
    out.push(...(rows || []));
  }
  return out;
}

export async function refreshBatchProgress(batchId) {
  const items = await request(`/send_batch_items?batch_id=eq.${encodeURIComponent(String(batchId))}&order=position.asc&select=position,status`);
  let sent = 0;
  let failed = 0;
  let pending = 0;
  let sending = 0;
  let skipped = 0;
  let nextIndex = items?.length || 0;

  for (const row of items || []) {
    if (row.status === 'SENT') sent += 1;
    else if (row.status === 'FAILED') failed += 1;
    else if (row.status === 'PENDING') {
      pending += 1;
      nextIndex = Math.min(nextIndex, Number(row.position));
    } else if (row.status === 'SENDING') {
      sending += 1;
      nextIndex = Math.min(nextIndex, Number(row.position));
    } else if (row.status === 'SKIPPED') skipped += 1;
  }

  const now = new Date().toISOString();
  const rows = await request(`/send_batches?id=eq.${encodeURIComponent(String(batchId))}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      next_index: nextIndex,
      sent_count: sent,
      failed_count: failed,
      updated_at: now,
    }),
  });

  return {
    batch: rows?.[0] || null,
    total: items?.length || 0,
    sent,
    failed,
    pending,
    sending,
    skipped,
    done: pending === 0 && sending === 0,
  };
}

export async function completeBatchIfDone(batchId) {
  const progress = await refreshBatchProgress(batchId);
  if (!progress.done) return { ...progress, transitioned: false };

  const now = new Date().toISOString();
  const rows = await request(`/send_batches?id=eq.${encodeURIComponent(String(batchId))}&status=eq.RUNNING`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'COMPLETED', completed_at: now, updated_at: now }),
  });

  return {
    ...progress,
    batch: rows?.[0] || progress.batch,
    transitioned: Boolean(rows?.length),
  };
}

export async function markBatchRolledBack(batchId) {
  const now = new Date().toISOString();
  const rows = await request(`/send_batches?id=eq.${encodeURIComponent(String(batchId))}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'ROLLED_BACK', rolled_back_at: now, updated_at: now }),
  });
  return rows?.[0] || null;
}
