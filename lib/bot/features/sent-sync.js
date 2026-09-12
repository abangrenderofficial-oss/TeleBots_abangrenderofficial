import { getQueueItem, getSetting, setSetting } from '../../store.js';
import { telegram } from '../../telegram.js';

const MODE_KEY = 'sent_edit_sync_mode';
const AUTO_DEBOUNCE_MS = 220;

export function normalizeSentSyncMode(value) {
  return String(value || '').toLowerCase() === 'auto' ? 'auto' : 'button';
}

export async function getSentSyncMode() {
  return normalizeSentSyncMode(await getSetting(MODE_KEY).catch(() => null));
}

export async function setSentSyncMode(mode) {
  const normalized = normalizeSentSyncMode(mode);
  await setSetting(MODE_KEY, normalized);
  return normalized;
}

export function canSyncSentItem(item) {
  return Boolean(
    item
      && String(item.status || '').toUpperCase() === 'SENT'
      && item.destination_chat_id != null
      && Number.isInteger(Number(item.destination_message_id))
      && Number(item.destination_message_id) > 0,
  );
}

export async function markSentSyncPending(itemId, reason = 'edit') {
  if (!itemId) return null;
  return setSetting(`sent_sync_pending:${itemId}`, {
    pending: true,
    reason,
    at: new Date().toISOString(),
  }).catch(() => null);
}

export async function clearSentSyncPending(itemId) {
  if (!itemId) return null;
  return setSetting(`sent_sync_pending:${itemId}`, null).catch(() => null);
}

export async function getSentSyncPending(itemId) {
  if (!itemId) return null;
  const value = await getSetting(`sent_sync_pending:${itemId}`).catch(() => null);
  return value?.pending ? value : null;
}

export async function maybeSyncSentItem(itemOrId, options = {}) {
  const force = Boolean(options.force);
  const reason = String(options.reason || 'edit');
  const mode = force ? 'button' : await getSentSyncMode();
  const item = typeof itemOrId === 'object' && itemOrId
    ? itemOrId
    : await getQueueItem(itemOrId);

  if (!canSyncSentItem(item)) return { ok: true, skipped: 'not_sent' };

  if (!force && mode !== 'auto') {
    await markSentSyncPending(item.id, reason);
    return { ok: true, pending: true, mode };
  }

  if (!force) {
    const token = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const tokenKey = `sent_sync_token:${item.id}`;
    await setSetting(tokenKey, { token, at: new Date().toISOString() });
    await sleep(AUTO_DEBOUNCE_MS);
    const latestToken = await getSetting(tokenKey).catch(() => null);
    if (latestToken?.token !== token) {
      return { ok: true, skipped: 'superseded', mode };
    }
  }

  return syncSentItemById(item.id, { reason, mode, telegramFn: options.telegramFn });
}

export async function syncSentItemById(itemId, options = {}) {
  const getItem = options.getItemFn || getQueueItem;
  const persist = options.persistFn || setSetting;
  const telegramFn = options.telegramFn || telegram;
  const reason = String(options.reason || 'manual');
  const mode = normalizeSentSyncMode(options.mode || (await getSentSyncMode()));
  const maxAttempts = 4;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const item = await getItem(itemId);
    if (!canSyncSentItem(item)) return { ok: false, reason: 'not_syncable' };

    const payload = {
      chat_id: item.destination_chat_id,
      message_id: Number(item.destination_message_id),
      caption: item.final_caption_html || '',
      parse_mode: 'HTML',
    };

    try {
      await telegramFn('editMessageCaption', payload);
    } catch (error) {
      const errorText = String(error?.message || error || 'sync failed');
      if (!/message is not modified/i.test(errorText)) {
        await persist(`sent_sync_last:${item.id}`, {
          ok: false,
          reason,
          mode,
          destination_chat_id: String(item.destination_chat_id),
          destination_message_id: Number(item.destination_message_id),
          error: errorText.slice(0, 500),
          at: new Date().toISOString(),
        }).catch(() => {});
        return { ok: false, reason: 'telegram_edit_failed', error: errorText };
      }
    }

    // A newer edit may have committed while Telegram was processing this one.
    // Re-read the item after the API call and repair the group caption if needed.
    // This makes the latest completed edit win even when an older request
    // finishes after a newer one.
    const latest = await getItem(itemId);
    if (
      canSyncSentItem(latest)
      && String(latest.destination_chat_id) === String(payload.chat_id)
      && Number(latest.destination_message_id) === payload.message_id
      && String(latest.final_caption_html || '') === payload.caption
    ) {
      await Promise.all([
        persist(`sent_sync_pending:${item.id}`, null).catch(() => {}),
        persist(`sent_sync_last:${item.id}`, {
          ok: true,
          reason,
          mode,
          destination_chat_id: String(payload.chat_id),
          destination_message_id: payload.message_id,
          at: new Date().toISOString(),
        }).catch(() => {}),
      ]);
      return {
        ok: true,
        synced: true,
        mode,
        destination_chat_id: String(payload.chat_id),
        destination_message_id: payload.message_id,
      };
    }
  }

  // Continuous edits exceeded the bounded repair loop. Keep the pending flag
  // so the owner can retry instead of falsely reporting the group as synced.
  await persist(`sent_sync_pending:${itemId}`, {
    pending: true,
    reason: 'concurrent_edit_retry',
    at: new Date().toISOString(),
  }).catch(() => {});
  return { ok: false, reason: 'concurrent_edit_retry', mode };
}

export function shouldAutoSync(mode, force = false) {
  if (force) return true;
  return normalizeSentSyncMode(mode) === 'auto';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
