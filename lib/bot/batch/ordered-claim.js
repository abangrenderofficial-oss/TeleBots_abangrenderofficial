function apiBase() {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('SUPABASE_URL is not configured');
  return `${base}/rest/v1`;
}

function headers() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
}

// One atomic database function owns claim ordering. It serializes claim attempts
// per batch and refuses to claim position N+1 while position N is still SENDING.
// This prevents duplicate Vercel worker invocations from racing group sends out
// of order.
export async function claimNextOrderedBatchItem(batchId) {
  const response = await fetch(`${apiBase()}/rpc/claim_send_batch_item_ordered`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ p_batch_id: String(batchId) }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ordered claim error ${response.status}: ${text}`);
  }

  if (!text) return null;
  const rows = JSON.parse(text);
  return Array.isArray(rows) ? (rows[0] || null) : (rows || null);
}
