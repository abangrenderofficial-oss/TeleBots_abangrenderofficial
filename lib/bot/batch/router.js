import { startNormalBatch, startResendBatch } from './start.js';
import { resumeLatest } from './control.js';
import {
  cancelExactReset,
  cancelLegacyReset,
  confirmExactReset,
  confirmLegacyReset,
  prepareExactReset,
} from './reset.js';

export function classifyBatchCallback(data) {
  const value = String(data || '');
  if (value === 'sendall') return { type: 'sendall' };
  if (value.startsWith('resendall:')) return { type: 'resendall', id: value.slice('resendall:'.length) };
  if (value === 'hard_resume') return { type: 'resume' };
  if (value.startsWith('reset_exact_confirm:')) return { type: 'reset_exact_confirm', id: value.slice('reset_exact_confirm:'.length) };
  if (value.startsWith('reset_exact_cancel:')) return { type: 'reset_exact_cancel', id: value.slice('reset_exact_cancel:'.length) };
  if (value.startsWith('reset_exact:')) return { type: 'reset_exact', id: value.slice('reset_exact:'.length) };
  if (value === 'resetbatch_confirm') return { type: 'reset_legacy_confirm' };
  if (value === 'resetbatch_cancel') return { type: 'reset_legacy_cancel' };
  return null;
}

export async function routeBatchCallback({ query, res }) {
  const parsed = classifyBatchCallback(query?.data);
  if (!parsed) return false;

  const chatId = query?.message?.chat?.id;
  if (!chatId) return false;

  if (parsed.type === 'sendall') return startNormalBatch({ chatId, query, res });
  if (parsed.type === 'resendall') return startResendBatch({ chatId, query, anchorItemId: parsed.id, res });
  if (parsed.type === 'resume') return resumeLatest({ chatId, query, res });
  if (parsed.type === 'reset_exact') return prepareExactReset({ chatId, batchId: parsed.id, query, res });
  if (parsed.type === 'reset_exact_confirm') return confirmExactReset({ chatId, batchId: parsed.id, query, res });
  if (parsed.type === 'reset_exact_cancel') return cancelExactReset({ chatId, query, res });
  if (parsed.type === 'reset_legacy_confirm') return confirmLegacyReset({ chatId, query, res });
  if (parsed.type === 'reset_legacy_cancel') return cancelLegacyReset({ chatId, query, res });

  return false;
}
