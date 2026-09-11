import legacyHandler from './telegram.js';
import { inspectIncomingDuplicate } from '../lib/duplicates.js';
import { telegram, isAdminMessage, inlineKeyboard } from '../lib/telegram.js';
import { getProfileForItem, processMediaWithProfile } from '../lib/format-profiles.js';
import { applyFormatRemoveTerms } from '../lib/remove-words.js';
import { maybeAutoNameUntitledDocument } from '../lib/untitled-namer.js';
import {
  getQueueItem,
  getQueueItemBySourceMessage,
  getSetting,
  listQueueItems,
  setSetting,
  updateQueueItem,
} from '../lib/store.js';

const DUP_MARKER_PREFIX = 'DUP_REVIEW:';
const DUP_OVERRIDE_PREFIX = 'duplicate_override:';
const DUP_FLUSH_TOKEN_PREFIX = 'duplicate_review_flush:';
const DUP_CURRENT_SUMMARY_PREFIX = 'duplicate_review_summary_current:';
const DUP_BATCH_PREFIX = 'duplicate_review_batch:';
const DUP_SETTLE_MS = 1800;
const DUP_SUMMARY_MERGE_MS = 15_000;
const DUP_SCAN_WINDOW_MS = 2 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return legacyHandler(req, res);

  const update = req.body || {};
  const query = update.callback_query;

  if (query?.data?.startsWith('dup_recap:')) {
    return handleDuplicateRecaption(query, res);
  }

  const message = update.message;
  if (!message || message.chat?.type !== 'private' || !isAdminMessage(message) || !hasMedia(message)) {
    return legacyHandler(req, res);
  }

  const media = identifyMedia(message);
  const duplicateInput = {
    adminChatId: message.chat.id,
    sourceChatId: message.chat.id,
    sourceMessageId: message.message_id,
    fileUniqueId: media.fileUniqueId || '',
    caption: message.caption || '',
    fileName: media.fileName || '',
  };

  const exact = await inspectIncomingDuplicate(duplicateInput).catch(() => null);
  if (exact?.kind !== 'exact_file' || !exact?.match?.id) {
    return legacyHandler(req, res);
  }

  const overrideKey = `${DUP_OVERRIDE_PREFIX}${message.chat.id}:${message.message_id}`;
  await setSetting(overrideKey, {
    allow: true,
    match_id: exact.match.id,
    detected_at: new Date().toISOString(),
  });

  const shadow = createShadowResponse();
  try {
    await legacyHandler(req, shadow);

    const item = await getQueueItemBySourceMessage(
      message.chat.id,
      message.chat.id,
      message.message_id,
    ).catch(() => null);

    if (item?.id) {
      await updateQueueItem(item.id, {
        file_unique_id: media.fileUniqueId || item.file_unique_id || null,
        error_message: `${DUP_MARKER_PREFIX}${exact.match.id}`,
        status: item.status === 'FAILED' ? 'FAILED' : 'READY',
      }).catch(() => {});

      await queueDuplicateReviewSummary(message.chat.id).catch((error) => {
        console.error('Duplicate review summary failed:', error?.message || error);
      });
    }
  } finally {
    await setSetting(overrideKey, null).catch(() => {});
  }

  return res.status(shadow.statusCode || 200).json(shadow.body || { ok: true });
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

async function queueDuplicateReviewSummary(chatId) {
  const key = `${DUP_FLUSH_TOKEN_PREFIX}${chatId}`;
  const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await setSetting(key, { token, at: new Date().toISOString() });
  await sleep(DUP_SETTLE_MS);

  const latest = await getSetting(key).catch(() => null);
  if (latest?.token !== token) return;
  await flushDuplicateReviewSummary(chatId);
}

async function flushDuplicateReviewSummary(chatId) {
  const rows = await listQueueItems(chatId, 160);
  const cutoff = Date.now() - DUP_SCAN_WINDOW_MS;
  const fresh = (rows || [])
    .filter((row) => String(row.admin_chat_id) === String(chatId))
    .filter((row) => String(row.error_message || '').startsWith(DUP_MARKER_PREFIX))
    .filter((row) => {
      const created = Date.parse(row.created_at || 0);
      return Number.isFinite(created) && created >= cutoff;
    })
    .sort((a, b) => Number(a.source_message_id) - Number(b.source_message_id));

  if (!fresh.length) return;

  const freshEntries = fresh.map((row) => ({
    item_id: row.id,
    match_id: String(row.error_message || '').slice(DUP_MARKER_PREFIX.length),
  })).filter((entry) => entry.match_id);

  const currentKey = `${DUP_CURRENT_SUMMARY_PREFIX}${chatId}`;
  const current = await getSetting(currentKey).catch(() => null);
  const currentAge = current?.updated_at ? Date.now() - Date.parse(current.updated_at) : Infinity;
  const reuseCurrent = Boolean(
    current?.batch_id
    && current?.message_id
    && Number.isFinite(currentAge)
    && currentAge >= 0
    && currentAge <= DUP_SUMMARY_MERGE_MS
  );

  const batchId = reuseCurrent
    ? String(current.batch_id)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const batchKey = `${DUP_BATCH_PREFIX}${chatId}:${batchId}`;
  const oldBatch = reuseCurrent ? await getSetting(batchKey).catch(() => null) : null;
  const merged = mergeEntries(oldBatch?.entries || [], freshEntries);

  await setSetting(batchKey, {
    chat_id: String(chatId),
    batch_id: batchId,
    entries: merged,
    created_at: oldBatch?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const text = await buildDuplicateSummaryText(chatId, merged);
  const replyMarkup = inlineKeyboard([[
    { text: '♻️ RECAPTION AGAIN', callback_data: `dup_recap:${batchId}` },
  ]]);

  let messageId = current?.message_id || null;
  if (reuseCurrent) {
    await telegram('editMessageText', {
      chat_id: chatId,
      message_id: current.message_id,
      text,
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    }).catch(() => {});
  } else {
    const sent = await telegram('sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    });
    messageId = sent?.message_id || null;
  }

  if (messageId) {
    await setSetting(currentKey, {
      batch_id: batchId,
      message_id: messageId,
      updated_at: new Date().toISOString(),
    });
  }

  await Promise.all(fresh.map((row) => updateQueueItem(row.id, { error_message: null }).catch(() => {})));
}

function mergeEntries(existing, incoming) {
  const map = new Map();
  for (const entry of [...(existing || []), ...(incoming || [])]) {
    if (!entry?.item_id || !entry?.match_id) continue;
    map.set(String(entry.item_id), {
      item_id: String(entry.item_id),
      match_id: String(entry.match_id),
    });
  }
  return [...map.values()];
}

async function buildDuplicateSummaryText(chatId, entries) {
  const rows = await listQueueItems(chatId, 500);
  const rowMap = new Map((rows || []).map((row) => [String(row.id), row]));

  for (const entry of entries) {
    if (!rowMap.has(String(entry.match_id))) {
      const old = await getQueueItem(entry.match_id).catch(() => null);
      if (old) rowMap.set(String(old.id), old);
    }
    if (!rowMap.has(String(entry.item_id))) {
      const fresh = await getQueueItem(entry.item_id).catch(() => null);
      if (fresh) rowMap.set(String(fresh.id), fresh);
    }
  }

  const groups = new Map();
  for (const entry of entries) {
    const fresh = rowMap.get(String(entry.item_id));
    const old = rowMap.get(String(entry.match_id));
    if (!fresh && !old) continue;

    const serial = extractDisplaySerial([
      old?.generated_title,
      old?.file_name,
      old?.original_caption,
      fresh?.generated_title,
      fresh?.file_name,
      fresh?.original_caption,
    ].filter(Boolean).join('\n'));

    const key = serial || String(entry.match_id);
    const group = groups.get(key) || {
      serial: serial || deriveFallbackLabel(old || fresh),
      title: '',
      mediaCount: 0,
    };
    group.mediaCount += 1;

    if (!group.title) {
      group.title = meaningfulTitle(old, serial) || meaningfulTitle(fresh, serial) || '';
    }

    if (!group.title && serial) {
      const related = (rows || []).find((row) => (
        extractDisplaySerial([
          row.generated_title,
          row.file_name,
          row.original_caption,
        ].filter(Boolean).join('\n')) === serial
        && meaningfulTitle(row, serial)
      ));
      if (related) group.title = meaningfulTitle(related, serial);
    }

    groups.set(key, group);
  }

  const assets = [...groups.values()];
  const mediaCount = entries.length;
  const assetCount = assets.length || mediaCount;
  const countText = mediaCount !== assetCount
    ? `${assetCount} item yang sama dikesan (${mediaCount} media).`
    : `${assetCount} item yang sama dikesan.`;
  const list = assets.map((asset, index) => {
    const label = [asset.serial, asset.title].filter(Boolean).join(' — ');
    return `${index + 1}. ${label || 'Item tanpa tajuk'}`;
  }).join('\n');

  return [
    '⚠️ FILE SAMA DIKESAN',
    '',
    countText,
    'Status: item ni pernah berjaya SENT ke group.',
    '',
    list,
    '',
    'Tuan Abang Render nak hantar sekali lagi?',
    'Preview masih aktif — boleh EDIT, SEND atau SEND ALL macam item baru.',
  ].join('\n').slice(0, 3900);
}

async function handleDuplicateRecaption(query, res) {
  if (!query?.message || !isAdminMessage({ from: query.from })) {
    return res.status(200).json({ ok: true });
  }

  const chatId = query.message.chat.id;
  const batchId = String(query.data || '').slice('dup_recap:'.length);
  await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  const batch = await getSetting(`${DUP_BATCH_PREFIX}${chatId}:${batchId}`).catch(() => null);
  const entries = Array.isArray(batch?.entries) ? batch.entries : [];
  if (!entries.length) {
    await telegram('editMessageText', {
      chat_id: chatId,
      message_id: query.message.message_id,
      text: `${query.message.text || 'Duplicate review'}\n\nBatch ni dah tak ada item untuk recaption.`.slice(0, 3900),
    }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  let updatedCount = 0;
  for (const entry of entries) {
    const item = await getQueueItem(entry.item_id).catch(() => null);
    if (!item) continue;

    const profile = await getProfileForItem(item).catch(() => null);
    if (!profile) continue;

    const base = await processMediaWithProfile({
      caption: item.original_caption || '',
      fileName: item.file_name || '',
      profile,
    });
    const processed = await applyFormatRemoveTerms(profile.id, base);
    const nextStatus = String(item.status || '').toUpperCase() === 'SENT' ? 'SENT' : 'READY';

    let updated = await updateQueueItem(item.id, {
      generated_title: processed.title || null,
      final_caption_html: processed.finalCaptionHtml || null,
      caption_replaced: true,
      status: nextStatus,
      error_message: null,
    }).catch(() => null);

    if (updated?.media_kind === 'photo') {
      updated = await maybeAutoNameUntitledDocument({
        itemId: updated.id,
        chatId,
      }).catch(() => updated);
    }

    if (!updated) updated = await getQueueItem(item.id).catch(() => null);
    if (updated?.preview_message_id) {
      const rows = await compactRowsForItem(updated);
      await telegram('editMessageCaption', {
        chat_id: chatId,
        message_id: updated.preview_message_id,
        caption: updated.final_caption_html || '',
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard(rows),
      }).catch(() => {});
    }
    updatedCount += 1;
  }

  const baseText = String(query.message.text || '').replace(/\n\n♻️ Recaption siap[\s\S]*$/i, '');
  await telegram('editMessageText', {
    chat_id: chatId,
    message_id: query.message.message_id,
    text: `${baseText}\n\n♻️ Recaption siap untuk ${updatedCount} item. Preview dah dikemas kini.`.slice(0, 3900),
    reply_markup: inlineKeyboard([[
      { text: '♻️ RECAPTION AGAIN', callback_data: `dup_recap:${batchId}` },
    ]]),
    disable_web_page_preview: true,
  }).catch(() => {});

  return res.status(200).json({ ok: true, recaptioned: updatedCount });
}

async function compactRowsForItem(item) {
  if (String(item?.status || '').toUpperCase() !== 'SENT') {
    return [[
      { text: '✏️', callback_data: `edit:${item.id}` },
      { text: '✅ SEND', callback_data: `send:${item.id}` },
      { text: '🚀 SEND ALL', callback_data: 'sendall' },
    ]];
  }

  const [lastSentId, fileRecordRaw] = await Promise.all([
    getSetting('last_sent_item_id').catch(() => null),
    getSetting('last_sent_file_record').catch(() => 0),
  ]);
  const fileRecord = Number.isFinite(Number(fileRecordRaw)) ? Number(fileRecordRaw) : 0;
  const statusText = String(lastSentId) === String(item.id)
    ? `🏁 LAST SENT · FILE ${fileRecord}`
    : '✅ SENT';

  return [
    [{ text: statusText, callback_data: 'noop' }],
    [
      { text: '✏️', callback_data: `edit:${item.id}` },
      { text: '🔁 SEND AGAIN', callback_data: `resend:${item.id}` },
      { text: '🚀 SEND ALL', callback_data: `resendall:${item.id}` },
    ],
  ];
}

function meaningfulTitle(item, serial = '') {
  const raw = String(item?.generated_title || '').trim();
  if (!raw) return '';
  const fileStem = String(item?.file_name || '').replace(/\.[^.]+$/, '').trim();
  const serialNorm = normalize(serial);
  const stemNorm = normalize(fileStem);

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => {
      if (/^(?:\(?none\)?|untitled|no\s*title|n\/?a|null|undefined|-)$/i.test(line)) return false;
      const norm = normalize(line);
      if (serialNorm && norm === serialNorm) return false;
      if (stemNorm && norm === stemNorm) return false;
      return !looksLikeSerial(line);
    }) || '';
}

function extractDisplaySerial(text) {
  const tokens = String(text || '').match(/[A-Za-z0-9][A-Za-z0-9._-]{4,79}/g) || [];
  return tokens
    .map((token) => token.replace(/^[-_.]+|[-_.]+$/g, ''))
    .find(looksLikeSerial) || '';
}

function looksLikeSerial(value) {
  const token = String(value || '').trim();
  if (token.length < 5 || token.length > 80) return false;
  if (/\s/.test(token)) return false;
  if (!/\d/.test(token)) return false;
  if (!/[A-Za-z._-]/.test(token)) return false;
  if (/^https?:/i.test(token)) return false;
  return /^[A-Za-z0-9._-]+$/.test(token);
}

function deriveFallbackLabel(item) {
  return String(item?.file_name || item?.generated_title || 'Item lama')
    .replace(/\.[^.]+$/, '')
    .split(/\r?\n/)[0]
    .trim();
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hasMedia(message) {
  return Boolean(message.document || message.photo || message.video || message.animation || message.audio);
}

function identifyMedia(message) {
  if (message.document) return {
    kind: 'document',
    fileName: message.document.file_name,
    fileUniqueId: message.document.file_unique_id,
  };
  if (message.photo) {
    const photo = message.photo.at(-1);
    return { kind: 'photo', fileUniqueId: photo?.file_unique_id };
  }
  if (message.video) return {
    kind: 'video',
    fileName: message.video.file_name,
    fileUniqueId: message.video.file_unique_id,
  };
  if (message.animation) return {
    kind: 'animation',
    fileName: message.animation.file_name,
    fileUniqueId: message.animation.file_unique_id,
  };
  if (message.audio) return {
    kind: 'audio',
    fileName: message.audio.file_name,
    fileUniqueId: message.audio.file_unique_id,
  };
  return { kind: 'other' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
