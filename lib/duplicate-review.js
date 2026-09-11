import { telegram, inlineKeyboard } from './telegram.js';
import { getQueueItem, getSetting, listQueueItems, setSetting, updateQueueItem } from './store.js';

export const DUP_MARKER_PREFIX = 'DUP_REVIEW:';
const DUP_FLUSH_TOKEN_PREFIX = 'duplicate_review_flush:';
const DUP_CURRENT_SUMMARY_PREFIX = 'duplicate_review_summary_current:';
const DUP_BATCH_PREFIX = 'duplicate_review_batch:';
const DUP_SETTLE_MS = 1800;
const DUP_SUMMARY_MERGE_MS = 15_000;
const DUP_SCAN_WINDOW_MS = 2 * 60 * 1000;

export async function markDuplicateForReview({ chatId, itemId, matchId }) {
  if (!chatId || !itemId || !matchId) return;
  const item = await getQueueItem(itemId).catch(() => null);
  if (!item) return;

  await updateQueueItem(itemId, {
    error_message: `${DUP_MARKER_PREFIX}${matchId}`,
    status: String(item.status || '').toUpperCase() === 'FAILED' ? 'FAILED' : 'READY',
  }).catch(() => {});

  await queueDuplicateReviewSummary(chatId).catch((error) => {
    console.error('Grouped duplicate review failed:', error?.message || error);
  });
}

export async function queueDuplicateReviewSummary(chatId) {
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
    'Status: item ini pernah berjaya SENT ke group.',
    '',
    list,
    '',
    'Tuan Abang Render nak hantar sekali lagi?',
    'Preview masih aktif — boleh EDIT, SEND atau SEND ALL macam item baru.',
  ].join('\n').slice(0, 3900);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
