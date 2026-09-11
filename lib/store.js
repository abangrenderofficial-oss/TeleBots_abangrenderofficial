const table = (name) => `${process.env.SUPABASE_URL}/rest/v1/${name}`;

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

async function request(url, options = {}) {
  const res = await fetch(url, { ...options, headers: headers(options.headers) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function safeLimit(value, fallback = 20, max = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export async function getSetting(key) {
  const rows = await request(`${table('bot_settings')}?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows?.[0]?.value ?? null;
}

export async function setSetting(key, value) {
  return request(table('bot_settings'), {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

export async function createQueueItem(item) {
  const rows = await request(table('queue_items'), {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(item),
  });
  return rows?.[0];
}

export async function getQueueItem(id) {
  const rows = await request(`${table('queue_items')}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return rows?.[0] ?? null;
}

export async function getQueueItemBySourceMessage(adminChatId, sourceChatId, sourceMessageId) {
  const rows = await request(
    `${table('queue_items')}?admin_chat_id=eq.${encodeURIComponent(adminChatId)}&source_chat_id=eq.${encodeURIComponent(sourceChatId)}&source_message_id=eq.${encodeURIComponent(sourceMessageId)}&order=created_at.desc&limit=1&select=*`,
  );
  return rows?.[0] ?? null;
}

export async function findQueueItemsByFileUniqueId(adminChatId, fileUniqueId, limit = 10) {
  const id = String(fileUniqueId || '').trim();
  if (!id) return [];
  return request(
    `${table('queue_items')}?admin_chat_id=eq.${encodeURIComponent(adminChatId)}&file_unique_id=eq.${encodeURIComponent(id)}&order=created_at.desc&limit=${safeLimit(limit, 10, 50)}&select=*`,
  );
}

export async function getLatestQueueItem(adminChatId) {
  const rows = await request(
    `${table('queue_items')}?admin_chat_id=eq.${encodeURIComponent(adminChatId)}&status=in.(PENDING,READY,FAILED)&order=created_at.desc&limit=1&select=*`,
  );
  return rows?.[0] ?? null;
}

export async function getLatestAnyQueueItem(adminChatId) {
  const rows = await request(
    `${table('queue_items')}?admin_chat_id=eq.${encodeURIComponent(adminChatId)}&order=created_at.desc&limit=1&select=*`,
  );
  return rows?.[0] ?? null;
}

export async function updateQueueItem(id, patch) {
  const rows = await request(`${table('queue_items')}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return rows?.[0];
}

async function recentSendAllAnchor() {
  const debug = await getSetting('telegram_callback_debug').catch(() => null);
  const events = Array.isArray(debug?.events) ? debug.events : [];
  const event = [...events].reverse().find((entry) => (
    String(entry?.data || '') === 'sendall'
    && entry?.message_id != null
    && entry?.chat_id != null
    && entry?.at
  ));

  if (!event) return null;

  const clickedAt = Date.parse(event.at);
  const ageMs = Date.now() - clickedAt;
  if (!Number.isFinite(clickedAt) || ageMs < 0 || ageMs > 20_000) return null;

  const rows = await request(
    `${table('queue_items')}?admin_chat_id=eq.${encodeURIComponent(event.chat_id)}&preview_message_id=eq.${encodeURIComponent(event.message_id)}&select=id,admin_chat_id,source_chat_id,source_message_id,created_at&limit=1`,
  );
  return rows?.[0] ?? null;
}

export async function listPending(limit = 20) {
  const n = safeLimit(limit);
  const anchor = await recentSendAllAnchor();

  if (anchor?.admin_chat_id != null && anchor?.source_message_id != null) {
    return request(
      `${table('queue_items')}?admin_chat_id=eq.${encodeURIComponent(anchor.admin_chat_id)}&source_chat_id=eq.${encodeURIComponent(anchor.source_chat_id)}&source_message_id=gte.${encodeURIComponent(anchor.source_message_id)}&status=in.(PENDING,READY,FAILED)&order=source_message_id.asc,created_at.asc&limit=${n}&select=*`,
    );
  }

  return request(`${table('queue_items')}?status=in.(PENDING,READY,FAILED)&order=created_at.asc&limit=${n}&select=*`);
}

export async function listQueueItems(adminChatId, limit = 500) {
  return request(
    `${table('queue_items')}?admin_chat_id=eq.${encodeURIComponent(adminChatId)}&order=created_at.desc&limit=${safeLimit(limit, 500)}&select=*`,
  );
}

export async function listQueueItemsByStatus(adminChatId, statuses = [], limit = 200) {
  const clean = (Array.isArray(statuses) ? statuses : [statuses])
    .map((x) => String(x || '').toUpperCase())
    .filter((x) => ['PENDING', 'READY', 'SENT', 'FAILED', 'SKIPPED'].includes(x));
  if (!clean.length) return listQueueItems(adminChatId, limit);
  return request(
    `${table('queue_items')}?admin_chat_id=eq.${encodeURIComponent(adminChatId)}&status=in.(${clean.join(',')})&order=created_at.desc&limit=${safeLimit(limit, 200)}&select=*`,
  );
}

export async function listSentItems(adminChatId, limit = 20) {
  return request(
    `${table('queue_items')}?admin_chat_id=eq.${encodeURIComponent(adminChatId)}&status=eq.SENT&order=sent_at.desc.nullslast,created_at.desc&limit=${safeLimit(limit)}&select=*`,
  );
}

export async function searchQueueItems(adminChatId, query, limit = 20) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  const rows = await listQueueItems(adminChatId, 500);
  return (rows || []).filter((row) => {
    const haystack = [row.file_name, row.generated_title, row.original_caption, row.destination_chat_id]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    return haystack.includes(needle);
  }).slice(0, safeLimit(limit));
}

export async function stats() {
  const rows = await request(`${table('queue_items')}?media_kind=eq.document&select=status,caption_replaced`);
  const result = { total: rows.length, sent: 0, pending: 0, failed: 0, skipped: 0, caption_replaced: 0 };
  for (const row of rows) {
    if (row.status === 'SENT') result.sent += 1;
    if (['PENDING', 'READY'].includes(row.status)) result.pending += 1;
    if (row.status === 'FAILED') result.failed += 1;
    if (row.status === 'SKIPPED') result.skipped += 1;
    if (row.caption_replaced) result.caption_replaced += 1;
  }
  return result;
}

export async function saveExample(originalCaption, correctedTitle) {
  return request(table('teaching_examples'), {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ original_caption: originalCaption, corrected_title: correctedTitle }),
  });
}

export async function recentExamples(limit = 12) {
  return request(`${table('teaching_examples')}?order=created_at.desc&limit=${safeLimit(limit)}&select=original_caption,corrected_title,created_at`);
}

export async function saveChatMessage(adminChatId, role, content) {
  const rows = await request(table('ai_chat_messages'), {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ admin_chat_id: adminChatId, role, content }),
  });
  return rows?.[0];
}

export async function recentChatMessages(adminChatId, limit = 18) {
  const rows = await request(
    `${table('ai_chat_messages')}?admin_chat_id=eq.${encodeURIComponent(adminChatId)}&order=created_at.desc&limit=${safeLimit(limit)}&select=role,content,created_at`,
  );
  return (rows || []).reverse();
}

export async function clearChatHistory(adminChatId) {
  return request(`${table('ai_chat_messages')}?admin_chat_id=eq.${encodeURIComponent(adminChatId)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

export async function addMemory(adminChatId, content) {
  const rows = await request(table('ai_memories'), {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ admin_chat_id: adminChatId, content }),
  });
  return rows?.[0];
}

export async function listMemories(adminChatId, limit = 50) {
  return request(
    `${table('ai_memories')}?admin_chat_id=eq.${encodeURIComponent(adminChatId)}&order=updated_at.desc&limit=${safeLimit(limit, 50)}&select=id,content,created_at,updated_at`,
  );
}

export async function deleteMemory(adminChatId, id) {
  return request(
    `${table('ai_memories')}?admin_chat_id=eq.${encodeURIComponent(adminChatId)}&id=eq.${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    },
  );
}
