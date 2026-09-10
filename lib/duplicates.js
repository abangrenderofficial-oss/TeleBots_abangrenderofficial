import {
  findQueueItemsByFileUniqueId,
  getQueueItemBySourceMessage,
  listQueueItems,
} from './store.js';

export async function inspectIncomingDuplicate({
  adminChatId,
  sourceChatId,
  sourceMessageId,
  fileUniqueId = '',
  caption = '',
  fileName = '',
  generatedTitle = '',
}) {
  const replay = await getQueueItemBySourceMessage(adminChatId, sourceChatId, sourceMessageId);
  if (replay) return { kind: 'webhook_replay', match: replay, confidence: 1 };

  if (fileUniqueId) {
    const exactMatches = await findQueueItemsByFileUniqueId(adminChatId, fileUniqueId, 10);
    const exact = (exactMatches || []).find((row) => !sameSourceMessage(row, sourceChatId, sourceMessageId));
    if (exact) {
      return {
        kind: 'exact_file',
        match: exact,
        confidence: 1,
        reason: 'Telegram file_unique_id sama.',
      };
    }
  }

  if (!generatedTitle) return { kind: 'none', match: null, confidence: 0 };

  const rows = await listQueueItems(adminChatId, 500);
  const candidates = (rows || []).filter((row) => !sameSourceMessage(row, sourceChatId, sourceMessageId));

  const incomingSerials = extractSerialCandidates([caption, fileName, generatedTitle].filter(Boolean).join('\n'));
  if (incomingSerials.length) {
    for (const row of candidates) {
      const oldSerials = extractSerialCandidates([
        row.original_caption,
        row.file_name,
        row.generated_title,
      ].filter(Boolean).join('\n'));
      const shared = incomingSerials.find((serial) => oldSerials.includes(serial));
      if (shared) {
        return {
          kind: 'same_serial',
          match: row,
          confidence: 0.93,
          serial: shared,
          reason: 'Serial/model identifier sama tetapi file Telegram berbeza.',
        };
      }
    }
  }

  const incomingTitle = normalizeTitle(generatedTitle);
  if (incomingTitle.length >= 8) {
    const sameTitle = candidates.find((row) => normalizeTitle(row.generated_title) === incomingTitle);
    if (sameTitle) {
      return {
        kind: 'same_title',
        match: sameTitle,
        confidence: 0.82,
        reason: 'Title normalized sama tetapi file Telegram berbeza.',
      };
    }
  }

  return { kind: 'none', match: null, confidence: 0 };
}

export function duplicateNotice(result) {
  const item = result?.match;
  if (!item) return '';

  const label = item.generated_title || item.file_name || 'item lama';
  const status = item.status || 'UNKNOWN';
  const when = formatMalaysiaDateTime(item.sent_at || item.created_at);

  if (result.kind === 'exact_file') {
    return `Duplicate exact dikesan.\nItem asal: ${label}\nStatus asal: ${status}${when ? `\nMasa: ${when}` : ''}`;
  }

  if (result.kind === 'same_serial') {
    return `Aku jumpa siri/model yang sama (${result.serial}) pada item lama: ${label}. File baru ni berbeza, jadi aku tak delete dan aku terus proses sebagai item baru.`;
  }

  if (result.kind === 'same_title') {
    return `Title ni sama dengan item lama: ${label}. File baru ni berbeza, jadi aku tak delete dan aku terus proses sebagai item baru.`;
  }

  return '';
}

function sameSourceMessage(row, sourceChatId, sourceMessageId) {
  return String(row?.source_chat_id) === String(sourceChatId)
    && String(row?.source_message_id) === String(sourceMessageId);
}

function extractSerialCandidates(text) {
  const source = String(text || '');
  const tokens = source.match(/[A-Za-z0-9][A-Za-z0-9._-]{3,79}/g) || [];
  const normalized = tokens
    .map((token) => token.replace(/^[-_.]+|[-_.]+$/g, '').toLowerCase())
    .filter((token) => token.length >= 5)
    .filter((token) => /\d/.test(token))
    .filter((token) => /[a-z._-]/i.test(token))
    .filter((token) => !/^\d{4}[-_.]\d{1,2}[-_.]\d{1,2}$/.test(token));
  return [...new Set(normalized)].slice(0, 12);
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#[\p{L}\p{N}_-]+/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatMalaysiaDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('ms-MY', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
