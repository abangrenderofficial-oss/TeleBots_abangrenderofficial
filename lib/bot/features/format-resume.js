import { listQueueItems } from '../../store.js';
import { getFormatReview, isFormatPipelinePaused } from './format-gate.js';
import { processPendingItem } from './media.js';

const MAX_PER_PASS = 40;
const MAX_SOURCE_WINDOW = 2000;

export async function resumeFormatQueue(chatId, review, options = {}) {
  if (await isFormatPipelinePaused(chatId)) {
    return { ok: false, blocked: 'format_review_still_active', processed: 0, remaining: 0 };
  }

  const limit = Math.min(Math.max(Number(options.limit) || MAX_PER_PASS, 1), 100);
  const rows = await listQueueItems(chatId, 1000);
  const scoped = selectPausedQueueWindow(rows, review, chatId);

  let processed = 0;
  let pausedAgain = false;
  for (const item of scoped.slice(0, limit)) {
    const active = await getFormatReview(chatId);
    if (active?.paused) {
      pausedAgain = true;
      break;
    }

    const result = await processPendingItem(item, { resumed: true });
    processed += 1;
    if (result?.paused_new_format) {
      pausedAgain = true;
      break;
    }
  }

  return {
    ok: true,
    processed,
    remaining: Math.max(0, scoped.length - processed),
    paused_again: pausedAgain,
    scoped_total: scoped.length,
  };
}

export function selectPausedQueueWindow(rows, review, chatId) {
  const admin = String(chatId);
  const sourceChat = String(review?.queue_source_chat_id ?? chatId);
  const startSource = Number(review?.queue_start_source_message_id);
  const startCreated = Date.parse(review?.queue_start_created_at || review?.created_at || 0);
  if (!Number.isFinite(startSource) && !Number.isFinite(startCreated)) return [];

  return (rows || [])
    .filter((row) => String(row.admin_chat_id) === admin)
    .filter((row) => String(row.source_chat_id) === sourceChat)
    .filter((row) => ['PENDING', 'FAILED'].includes(String(row.status || '').toUpperCase()))
    .filter((row) => {
      const sourceId = Number(row.source_message_id);
      const created = Date.parse(row.created_at || 0);

      if (Number.isFinite(startSource)) {
        if (!Number.isFinite(sourceId) || sourceId < startSource) return false;
        if (sourceId - startSource > MAX_SOURCE_WINDOW) return false;
      }
      if (Number.isFinite(startCreated) && Number.isFinite(created) && created < startCreated) return false;
      return true;
    })
    .sort((a, b) => {
      const bySource = Number(a.source_message_id) - Number(b.source_message_id);
      if (Number.isFinite(bySource) && bySource !== 0) return bySource;
      return Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
    });
}
