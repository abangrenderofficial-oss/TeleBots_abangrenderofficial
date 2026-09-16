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
  const response = await fetch(url, { ...options, headers: headers(options.headers) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase recaption error ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function rpc(name, body) {
  return request(`${table(`rpc/${name}`)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function isForwardedMessage(message) {
  return Boolean(
    message?.forward_origin
    || message?.forward_date
    || message?.forward_from
    || message?.forward_from_chat
    || message?.forward_sender_name,
  );
}

export async function collectForwardedQueueItem({ message, media }) {
  const result = await rpc('collect_forwarded_queue_item', {
    p_admin_chat_id: Number(message.chat.id),
    p_source_chat_id: Number(message.chat.id),
    p_source_message_id: Number(message.message_id),
    p_media_kind: String(media.kind || 'other'),
    p_file_name: media.fileName || null,
    p_file_unique_id: media.fileUniqueId || null,
    p_original_caption: message.caption || null,
  });

  if (!result?.item?.id || !result?.session_id) {
    throw new Error('Collected item/session tak lengkap');
  }
  return result;
}

export async function closeActiveRecaptionCollection(chatId) {
  return rpc('close_recaption_collection', {
    p_admin_chat_id: Number(chatId),
  });
}

export async function listRecaptionSessionItems(chatId, sessionId, statuses = ['PENDING', 'FAILED'], limit = 1000) {
  const clean = (Array.isArray(statuses) ? statuses : [statuses])
    .map((status) => String(status || '').toUpperCase())
    .filter((status) => ['PENDING', 'READY', 'FAILED', 'SENT', 'SKIPPED'].includes(status));
  const statusFilter = clean.length ? `&status=in.(${clean.join(',')})` : '';
  return request(
    `${table('queue_items')}?admin_chat_id=eq.${encodeURIComponent(chatId)}`
    + `&recaption_session_id=eq.${encodeURIComponent(sessionId)}`
    + statusFilter
    + `&order=source_message_id.asc,created_at.asc&limit=${Math.min(Math.max(Number(limit) || 1000, 1), 1000)}&select=*`,
  );
}

export async function setRecaptionSessionStatus(sessionId, status, extra = {}) {
  const allowed = new Set(['PROCESSING', 'PAUSED', 'COMPLETED', 'FAILED']);
  const next = String(status || '').toUpperCase();
  if (!allowed.has(next)) throw new Error(`Recaption session status tak valid: ${next}`);

  const now = new Date().toISOString();
  const patch = {
    status: next,
    updated_at: now,
    ...(next === 'COMPLETED' ? { completed_at: now } : {}),
    ...extra,
  };
  const rows = await request(`${table('recaption_sessions')}?id=eq.${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  return rows?.[0] || null;
}

export async function getRecaptionSession(sessionId) {
  const rows = await request(
    `${table('recaption_sessions')}?id=eq.${encodeURIComponent(sessionId)}&select=*&limit=1`,
  );
  return rows?.[0] || null;
}
