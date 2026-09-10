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

export async function updateQueueItem(id, patch) {
  const rows = await request(`${table('queue_items')}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return rows?.[0];
}

export async function listPending(limit = 20) {
  return request(`${table('queue_items')}?status=in.(PENDING,READY,FAILED)&order=created_at.asc&limit=${limit}&select=*`);
}

export async function stats() {
  const rows = await request(`${table('queue_items')}?media_kind=eq.document&select=status,caption_replaced`);
  const result = { total: rows.length, sent: 0, pending: 0, failed: 0, caption_replaced: 0 };
  for (const row of rows) {
    if (row.status === 'SENT') result.sent += 1;
    if (['PENDING', 'READY'].includes(row.status)) result.pending += 1;
    if (row.status === 'FAILED') result.failed += 1;
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
  return request(`${table('teaching_examples')}?order=created_at.desc&limit=${limit}&select=original_caption,corrected_title`);
}
