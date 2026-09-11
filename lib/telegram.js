import { getQueueItem, getQueueItemBySourceMessage, getSetting, setSetting } from './store.js';

let callbackWebhookEnsured = false;
const STABLE_WEBHOOK_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram';
const FAST_UI_METHODS = new Set(['answerCallbackQuery', 'editMessageCaption', 'editMessageReplyMarkup']);
const LAST_SENT_FILE_RECORD_KEY = 'last_sent_file_record';
const SEND_BATCH_GAP_MS = 2 * 60 * 1000;
const SEND_DEDUPE_WAIT_MS = 15_000;
const SEND_DEDUPE_STALE_MS = 60_000;

export async function telegram(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  const forceResend = Boolean(payload?.__force_resend);
  const telegramPayload = forceResend ? { ...payload } : payload;
  if (forceResend) delete telegramPayload.__force_resend;

  // api/telegram.js historically deletes the old preview before rebuilding it.
  // For the currently focused item we now keep that message alive so the next
  // copyMessage call can edit the SAME media message in place instead.
  if (method === 'deleteMessage' && await isActivePreviewRefreshDelete(telegramPayload)) {
    return true;
  }

  let result = null;
  let editedExistingPreview = false;

  // A preview refresh should not create another Telegram message. If the item
  // already has a preview_message_id, edit that media message's caption and
  // inline keyboard in place. The photo/file itself stays exactly where it is.
  if (method === 'copyMessage' && isOwnerPreview(telegramPayload)) {
    const edited = await tryEditExistingOwnerPreview(token, telegramPayload);
    if (edited) {
      result = edited;
      editedExistingPreview = true;
    }
  }

  if (!editedExistingPreview) {
    if (method === 'copyMessage' && !isOwnerPreview(telegramPayload)) {
      // Normal sends are idempotent so Telegram webhook retries cannot duplicate
      // a forwarded occurrence. SEND AGAIN is an explicit owner action and is
      // therefore allowed to bypass that exact-occurrence dedupe once.
      result = forceResend
        ? await rawTelegram(token, method, telegramPayload)
        : await idempotentDestinationCopy(token, telegramPayload);
    } else {
      result = await rawTelegram(token, method, telegramPayload);
    }
  }

  // Fast UI actions should finish as soon as Telegram confirms the edit/ack.
  // Do not make the button wait for webhook self-heal or other housekeeping.
  if (FAST_UI_METHODS.has(method)) return result;

  // After a real copy to the destination group succeeds, mark the current
  // preview as LAST SENT while keeping edit/resend/send-all controls available.
  // A duplicate webhook/callback that merely reuses an already-sent destination
  // message must not update the marker again.
  if (method === 'copyMessage' && !isOwnerPreview(telegramPayload) && !result?.__deduped) {
    await updateLastSentPreviewStatus(token, telegramPayload).catch((error) => {
      console.error('Last sent marker update failed:', error?.message || error);
    });
  }

  // All inline buttons depend on callback_query updates. Always point Telegram
  // at the one stable production alias. Do not trust TELEGRAM_WEBHOOK_URL,
  // VERCEL_URL or VERCEL_PROJECT_PRODUCTION_URL here because any one of those
  // can contain an immutable/old deployment hostname and make every button look dead.
  if (method !== 'setWebhook') {
    await ensureCallbackWebhookSupport(token).catch((error) => {
      console.error('Webhook callback self-heal failed:', error?.message || error);
    });
  }

  // After a new/updated media preview, tell the owner when the caption structure
  // looks unfamiliar. This never blocks the workflow.
  if (method === 'copyMessage' && isOwnerPreview(telegramPayload)) {
    await maybeSendFormatLearningNotice(telegramPayload).catch((error) => {
      console.error('Format learning notice failed:', error);
    });
  }

  return result;
}

export async function repairTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  const result = await rawTelegram(token, 'setWebhook', {
    url: STABLE_WEBHOOK_URL,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  });

  callbackWebhookEnsured = true;

  // Persist a sanitized snapshot so we can prove what Telegram is actually using
  // without exposing the bot token or depending on Vercel log access.
  let info = null;
  try {
    const rawInfo = await rawTelegram(token, 'getWebhookInfo', {});
    info = {
      url: rawInfo?.url || null,
      pending_update_count: rawInfo?.pending_update_count ?? null,
      allowed_updates: rawInfo?.allowed_updates || null,
      last_error_date: rawInfo?.last_error_date || null,
      last_error_message: rawInfo?.last_error_message || null,
      checked_at: new Date().toISOString(),
    };
    await setSetting('telegram_webhook_debug', info).catch(() => {});
  } catch (error) {
    await setSetting('telegram_webhook_debug', {
      url: STABLE_WEBHOOK_URL,
      checked_at: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 500),
    }).catch(() => {});
  }

  return { ok: Boolean(result), url: STABLE_WEBHOOK_URL, info };
}

async function rawTelegram(token, method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || 'Unknown error'}`);
  }
  return data.result;
}

// Telegram can retry the SAME webhook while SEND ALL is still running. Two
// Vercel invocations could therefore reach copyMessage before queue_items flips
// to SENT. This DB-backed gate gives each exact forwarded occurrence one stable
// send key: destination + source chat + source message. Forwarding the same file
// again later still sends again because Telegram gives that forward a new
// source_message_id.
async function idempotentDestinationCopy(token, payload) {
  if (!payload?.chat_id || !payload?.from_chat_id || !payload?.message_id) {
    return rawTelegram(token, 'copyMessage', payload);
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return rawTelegram(token, 'copyMessage', payload);
  }

  const key = {
    destination_chat_id: String(payload.chat_id),
    source_chat_id: String(payload.from_chat_id),
    source_message_id: Number(payload.message_id),
  };

  let claimed = await tryInsertSendClaim(key).catch((error) => {
    console.error('Destination send claim insert failed:', error?.message || error);
    return false;
  });

  if (!claimed) {
    let existing = await getSendClaim(key).catch(() => null);

    if (existing?.status === 'SENT' && existing.destination_message_id) {
      return { message_id: Number(existing.destination_message_id), __deduped: true };
    }

    if (existing?.status === 'FAILED') {
      claimed = await tryTakeOverFailedSendClaim(key).catch(() => false);
    } else if (existing?.status === 'SENDING' && isStaleSendClaim(existing)) {
      claimed = await tryTakeOverStaleSendClaim(key).catch(() => false);
    }

    if (!claimed) {
      existing = await waitForExistingSend(key);
      if (existing?.status === 'SENT' && existing.destination_message_id) {
        return { message_id: Number(existing.destination_message_id), __deduped: true };
      }

      if (existing?.status === 'FAILED') {
        claimed = await tryTakeOverFailedSendClaim(key).catch(() => false);
      } else if (existing?.status === 'SENDING' && isStaleSendClaim(existing)) {
        claimed = await tryTakeOverStaleSendClaim(key).catch(() => false);
      }

      if (!claimed) {
        throw new Error('Destination copy is already in progress for this exact forwarded message');
      }
    }
  }

  try {
    const sent = await rawTelegram(token, 'copyMessage', payload);
    await completeSendClaim(key, sent?.message_id).catch((error) => {
      console.error('Destination send claim complete failed:', error?.message || error);
    });
    return { ...sent, __deduped: false };
  } catch (error) {
    await failSendClaim(key, error).catch(() => {});
    throw error;
  }
}

function dedupeTableUrl(params = '') {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  return `${base}/rest/v1/telegram_send_dedupe${params}`;
}

function dedupeHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    ...extra,
  };
}

function dedupeFilter(key) {
  return `destination_chat_id=eq.${encodeURIComponent(key.destination_chat_id)}`
    + `&source_chat_id=eq.${encodeURIComponent(key.source_chat_id)}`
    + `&source_message_id=eq.${encodeURIComponent(key.source_message_id)}`;
}

async function tryInsertSendClaim(key) {
  const response = await fetch(
    dedupeTableUrl('?on_conflict=destination_chat_id,source_chat_id,source_message_id'),
    {
      method: 'POST',
      headers: dedupeHeaders({ Prefer: 'resolution=ignore-duplicates,return=representation' }),
      body: JSON.stringify({
        ...key,
        status: 'SENDING',
        error_message: null,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!response.ok) throw new Error(`Supabase send claim ${response.status}: ${await response.text()}`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function getSendClaim(key) {
  const response = await fetch(
    dedupeTableUrl(`?${dedupeFilter(key)}&select=status,destination_message_id,error_message,updated_at&limit=1`),
    { headers: dedupeHeaders() },
  );
  if (!response.ok) throw new Error(`Supabase send claim read ${response.status}: ${await response.text()}`);
  const rows = await response.json().catch(() => []);
  return rows?.[0] || null;
}

async function tryTakeOverFailedSendClaim(key) {
  return patchSendClaimIf(key, 'status=eq.FAILED', {
    status: 'SENDING',
    error_message: null,
    updated_at: new Date().toISOString(),
  });
}

async function tryTakeOverStaleSendClaim(key) {
  const cutoff = new Date(Date.now() - SEND_DEDUPE_STALE_MS).toISOString();
  return patchSendClaimIf(
    key,
    `status=eq.SENDING&updated_at=lt.${encodeURIComponent(cutoff)}`,
    {
      status: 'SENDING',
      error_message: null,
      updated_at: new Date().toISOString(),
    },
  );
}

async function patchSendClaimIf(key, extraFilter, patch) {
  const response = await fetch(
    dedupeTableUrl(`?${dedupeFilter(key)}&${extraFilter}`),
    {
      method: 'PATCH',
      headers: dedupeHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify(patch),
    },
  );
  if (!response.ok) throw new Error(`Supabase send claim patch ${response.status}: ${await response.text()}`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function completeSendClaim(key, destinationMessageId) {
  return patchSendClaimIf(key, 'status=eq.SENDING', {
    status: 'SENT',
    destination_message_id: destinationMessageId ?? null,
    error_message: null,
    updated_at: new Date().toISOString(),
  });
}

async function failSendClaim(key, error) {
  return patchSendClaimIf(key, 'status=eq.SENDING', {
    status: 'FAILED',
    error_message: String(error?.message || error).slice(0, 1000),
    updated_at: new Date().toISOString(),
  });
}

async function waitForExistingSend(key) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < SEND_DEDUPE_WAIT_MS) {
    await sleep(180);
    latest = await getSendClaim(key).catch(() => null);
    if (!latest) return null;
    if (latest.status !== 'SENDING') return latest;
    if (isStaleSendClaim(latest)) return latest;
  }
  return latest;
}

function isStaleSendClaim(record) {
  const updatedAt = Date.parse(record?.updated_at || 0);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > SEND_DEDUPE_STALE_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sentControls(itemId) {
  return [
    { text: '✏️', callback_data: `edit:${itemId}` },
    { text: '🔁 SEND AGAIN', callback_data: `resend:${itemId}` },
    { text: '🚀 SEND ALL', callback_data: `resendall:${itemId}` },
  ];
}

async function updateLastSentPreviewStatus(token, payload) {
  if (!payload?.chat_id || !payload?.from_chat_id || !payload?.message_id) return;
  if (String(payload.chat_id) === String(payload.from_chat_id)) return;

  const adminChatId = payload.from_chat_id;
  const item = await getQueueItemBySourceMessage(
    adminChatId,
    payload.from_chat_id,
    payload.message_id,
  ).catch(() => null);
  if (!item?.id) return;

  const previousId = await getSetting('last_sent_item_id').catch(() => null);
  const previous = previousId
    ? await getQueueItem(previousId).catch(() => null)
    : null;

  // The FILE number is a record for the CURRENT forwarded batch, not lifetime
  // history in queue_items. A new burst resets the record. Photos/images never
  // increase the number; only Telegram documents/files do. Intentional resend of
  // an already-SENT file does not increase the file record again.
  const storedRecord = await getSetting(LAST_SENT_FILE_RECORD_KEY).catch(() => 0);
  let sentFileTotal = Number(storedRecord);
  if (!Number.isFinite(sentFileTotal) || sentFileTotal < 0) sentFileTotal = 0;

  const currentCreated = Date.parse(item.created_at || 0);
  const previousCreated = Date.parse(previous?.created_at || 0);
  const sameBatch = Boolean(
    previous
    && String(previous.admin_chat_id) === String(item.admin_chat_id)
    && String(previous.source_chat_id) === String(item.source_chat_id)
    && Number.isFinite(currentCreated)
    && Number.isFinite(previousCreated)
    && Math.abs(currentCreated - previousCreated) <= SEND_BATCH_GAP_MS
  );

  if (!sameBatch) sentFileTotal = 0;
  if (item.media_kind === 'document' && item.status !== 'SENT') sentFileTotal += 1;

  if (previous && String(previous.id) !== String(item.id) && previous.preview_message_id) {
    await rawTelegram(token, 'editMessageReplyMarkup', {
      chat_id: previous.admin_chat_id || adminChatId,
      message_id: previous.preview_message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ SENT', callback_data: 'noop' }],
          sentControls(previous.id),
        ],
      },
    }).catch((error) => {
      console.error('Previous SENT marker update failed:', error?.message || error);
    });
  }

  if (item.preview_message_id) {
    await rawTelegram(token, 'editMessageReplyMarkup', {
      chat_id: item.admin_chat_id || adminChatId,
      message_id: item.preview_message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: `🏁 LAST SENT · FILE ${sentFileTotal}`, callback_data: 'noop' }],
          sentControls(item.id),
        ],
      },
    }).catch((error) => {
      console.error('Current LAST SENT marker update failed:', error?.message || error);
    });
  }

  await Promise.all([
    setSetting('last_sent_item_id', item.id),
    setSetting(LAST_SENT_FILE_RECORD_KEY, sentFileTotal),
  ]);
}

async function tryEditExistingOwnerPreview(token, payload) {
  const itemId = extractItemId(payload.reply_markup);
  if (!itemId) return null;

  const item = await getQueueItem(itemId).catch(() => null);
  if (!item?.preview_message_id) return null;

  try {
    return await rawTelegram(token, 'editMessageCaption', {
      chat_id: payload.chat_id,
      message_id: item.preview_message_id,
      caption: payload.caption || '',
      parse_mode: payload.parse_mode || undefined,
      reply_markup: payload.reply_markup,
    });
  } catch (error) {
    // If the old preview was manually deleted / too old / otherwise cannot be
    // edited, fall back to the normal copyMessage path and make a fresh preview.
    console.error('Edit existing preview failed, falling back to copy:', error?.message || error);
    return null;
  }
}

async function isActivePreviewRefreshDelete(payload) {
  if (!payload?.chat_id || !payload?.message_id) return false;

  const state = await getSetting('admin_state').catch(() => null);
  if (state?.mode !== 'FOCUS_ITEM' || !state?.item_id) return false;

  const item = await getQueueItem(state.item_id).catch(() => null);
  if (!item?.preview_message_id) return false;

  const deletingPreview = String(item.preview_message_id) === String(payload.message_id);
  const deletingOriginalSource = String(item.source_message_id) === String(payload.message_id);
  return deletingPreview && !deletingOriginalSource;
}

async function ensureCallbackWebhookSupport(token) {
  if (callbackWebhookEnsured) return;

  // Never let a preview deployment steal the live Telegram webhook.
  const vercelEnv = String(process.env.VERCEL_ENV || '').trim();
  if (vercelEnv && vercelEnv !== 'production') return;

  callbackWebhookEnsured = true;
  try {
    await rawTelegram(token, 'setWebhook', {
      url: STABLE_WEBHOOK_URL,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
  } catch (error) {
    callbackWebhookEnsured = false;
    throw error;
  }
}

async function maybeSendFormatLearningNotice(payload) {
  const notice = await getSetting('format_learning_notice');
  if (!notice?.unknown) return;

  const detectedAt = new Date(notice.detected_at || 0).getTime();
  if (!detectedAt || Date.now() - detectedAt > 90_000) {
    await setSetting('format_learning_notice', null);
    return;
  }

  const itemId = extractItemId(payload.reply_markup);
  if (itemId) {
    await setSetting('admin_state', { mode: 'FOCUS_ITEM', item_id: itemId });
  }
  await setSetting('format_learning_notice', null);

  await telegram('sendMessage', {
    chat_id: payload.chat_id,
    text: 'Format ni nampak baru dan aku belum cukup belajar corak macam ni lagi. Aku tetap dah buat preview sementara. Kalau ada yang salah, cakap je macam biasa apa yang patut aku ambil, buang atau kekalkan — aku akan buat terus dan boleh belajar daripada correction tu.',
  });
}

function isOwnerPreview(payload) {
  if (!payload?.reply_markup?.inline_keyboard) return false;
  if (String(payload.chat_id) !== String(payload.from_chat_id)) return false;
  return payload.reply_markup.inline_keyboard
    .flat()
    .some((button) => {
      const data = String(button?.callback_data || '');
      return data.startsWith('send:') || data.startsWith('teach:');
    });
}

function extractItemId(replyMarkup) {
  const buttons = replyMarkup?.inline_keyboard?.flat?.() || [];
  for (const button of buttons) {
    const data = String(button?.callback_data || '');
    if (data.startsWith('send:')) return data.slice('send:'.length) || null;
    if (data.startsWith('teach:')) return data.slice('teach:'.length) || null;
  }
  return null;
}

export function isAdminMessage(message) {
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || '').trim();
  return Boolean(adminId && message?.from?.id && String(message.from.id) === adminId);
}

export function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}
