import safeDestinationHandler from './telegram-safe-destination.js';
import { telegram, isAdminMessage } from '../lib/telegram.js';
import { getQueueItem, getSetting, setSetting } from '../lib/store.js';

// Final reliability layer for LIVE GROUP SYNC.
// Old preview messages already contain callback_data with the queue item id, so
// they do NOT need to be recreated. We capture that id before the existing
// handler runs, then patch the exact destination message after any caption/edit
// action completes. Text replies to Remove Word / Ubah Caption / focused edits
// are covered through admin_state as well.
export default async function handler(req, res) {
  if (req.method !== 'POST') return safeDestinationHandler(req, res);

  const update = req.body || {};
  const query = update.callback_query;
  const message = update.message;

  let adminChatId = null;
  let targetId = null;
  let action = '';

  if (query?.message && isAdminMessage({ from: query.from })) {
    adminChatId = query.message.chat.id;
    const data = String(query.data || '');
    const parts = data.split(':');
    action = parts[0] || '';
    targetId = parts[1] || null;
  } else if (message?.chat?.type === 'private' && isAdminMessage(message)) {
    adminChatId = message.chat.id;
    const state = await getSetting('admin_state').catch(() => null);
    targetId = state?.item_id || null;
  }

  const before = targetId ? await getQueueItem(targetId).catch(() => null) : null;
  const shadow = createShadowResponse();
  await safeDestinationHandler(req, shadow);

  if (targetId && adminChatId != null) {
    const after = await getQueueItem(targetId).catch(() => null);
    if (isSentWithDestination(after)) {
      const callbackMayChangeCaption = action.startsWith('fmt_');
      const messageMayChangeCaption = Boolean(message && before);
      const actuallyChanged = captionChanged(before, after);

      // Force a destination patch for every format edit callback and every text
      // reply while an item is focused. This deliberately does not depend only
      // on before/after comparison, because old previews can enter edit flows
      // whose profile/footer state changes one step before the final caption.
      if (callbackMayChangeCaption || messageMayChangeCaption || actuallyChanged) {
        await forceLiveSync(after, adminChatId).catch(() => {});
      }
    }
  }

  return res.status(shadow.statusCode || 200).json(shadow.body || { ok: true });
}

function isSentWithDestination(item) {
  return Boolean(
    item?.id
    && String(item.status || '').toUpperCase() === 'SENT'
    && item.destination_chat_id
    && item.destination_message_id
  );
}

function captionChanged(before, after) {
  if (!before || !after) return false;
  return String(before.final_caption_html || '') !== String(after.final_caption_html || '')
    || String(before.generated_title || '') !== String(after.generated_title || '');
}

async function forceLiveSync(item, adminChatId) {
  try {
    await telegram('editMessageCaption', {
      chat_id: item.destination_chat_id,
      message_id: item.destination_message_id,
      caption: item.final_caption_html || '',
      parse_mode: 'HTML',
    });

    await setSetting(`sent_live_sync:${item.id}`, {
      ok: true,
      source: 'legacy_preview_reliability_layer',
      destination_chat_id: String(item.destination_chat_id),
      destination_message_id: item.destination_message_id,
      synced_at: new Date().toISOString(),
    }).catch(() => {});
    return { ok: true };
  } catch (error) {
    const text = String(error?.message || error);

    // The inner safety handler may already have applied the exact same caption.
    // Telegram returns "message is not modified" in that case; treat it as a
    // successful sync instead of confusing the owner with a false failure.
    if (/message is not modified/i.test(text)) {
      await setSetting(`sent_live_sync:${item.id}`, {
        ok: true,
        source: 'legacy_preview_reliability_layer_already_current',
        destination_chat_id: String(item.destination_chat_id),
        destination_message_id: item.destination_message_id,
        synced_at: new Date().toISOString(),
      }).catch(() => {});
      return { ok: true, already_current: true };
    }

    await setSetting(`sent_live_sync:${item.id}`, {
      ok: false,
      source: 'legacy_preview_reliability_layer',
      error: text.slice(0, 500),
      failed_at: new Date().toISOString(),
    }).catch(() => {});

    await telegram('sendMessage', {
      chat_id: adminChatId,
      text: `⚠️ LIVE GROUP SYNC gagal untuk item ni. ${text}`.slice(0, 1000),
    }).catch(() => {});
    return { ok: false, error: text };
  }
}

function createShadowResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}
