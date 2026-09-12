import { processMediaWithProfile } from '../../format-profiles.js';
import { applyFormatRemoveTerms } from '../../remove-words.js';
import { getQueueItem, updateQueueItem } from '../../store.js';
import { maybeSyncSentItem } from './sent-sync.js';

export async function recaptionItemWithProfile(itemId, profile, options = {}) {
  const item = await getQueueItem(itemId);
  if (!item) throw new Error('Item tak jumpa');

  const startedAt = Date.now();
  const needsAi = Boolean(profile?.actions?.translate);
  const baseProcessed = await processMediaWithProfile({
    caption: item.original_caption || '',
    fileName: item.file_name || '',
    profile,
    // Learned non-translation formats are deterministic/local. Translation is
    // the only profile action that genuinely requires the AI path.
    fast: !needsAi,
    useAi: needsAi,
  });
  const processed = await applyFormatRemoveTerms(profile.id, baseProcessed);
  const validation = validateProcessedAgainstProfile(processed, profile, item);
  if (!validation.ok) {
    throw new Error(`Recaption validation failed: ${validation.errors.join('; ')}`);
  }

  const updated = await updateQueueItem(item.id, {
    generated_title: processed.title || null,
    final_caption_html: processed.finalCaptionHtml || null,
    caption_replaced: true,
    status: item.status === 'SENT' ? 'SENT' : 'READY',
    error_message: null,
  });

  const sync = options.syncSent === false
    ? { ok: true, skipped: 'disabled' }
    : await maybeSyncSentItem(updated, { reason: options.reason || 'recaption' });

  return {
    item: updated,
    processed,
    validation,
    sync,
    elapsed_ms: Date.now() - startedAt,
  };
}

export function validateProcessedAgainstProfile(processed, profile, item = {}) {
  const errors = [];
  const actions = {
    take_title: true,
    take_serial: false,
    translate: false,
    remove_hashtags: true,
    add_footer: true,
    ...(profile?.actions || {}),
  };
  const title = String(processed?.title || '');
  const finalCaption = String(processed?.finalCaptionHtml || '');
  const footer = String(profile?.footer_html || '').trim();

  if (actions.remove_hashtags && /(^|\s)#[\p{L}\p{N}_-]+/u.test(title)) {
    errors.push('hashtag remained in title');
  }

  if (!actions.take_title && !actions.take_serial && title.trim()) {
    errors.push('title exists while title and serial are both disabled');
  }

  if (actions.take_serial) {
    const expectedSerial = detectLeadingSerial(item.original_caption || '', item.file_name || '');
    if (expectedSerial && !title.toLowerCase().includes(expectedSerial.toLowerCase())) {
      errors.push('required serial missing from title');
    }
  }

  if (!actions.add_footer && footer && finalCaption.includes(footer)) {
    errors.push('footer present while footer action is disabled');
  }

  if (actions.add_footer && footer && !finalCaption.includes(footer)) {
    errors.push('configured format footer missing');
  }

  return { ok: errors.length === 0, errors };
}

export function compareRecaptionResult(a, b) {
  return Boolean(
    String(a?.title || '') === String(b?.title || '')
      && String(a?.finalCaptionHtml || '') === String(b?.finalCaptionHtml || ''),
  );
}

function detectLeadingSerial(caption, fileName = '') {
  const lines = String(caption || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));
  if (looksLikeSerial(lines[0])) return lines[0];

  const tokens = `${caption || ''}\n${fileName || ''}`.match(/[A-Za-z0-9][A-Za-z0-9._-]{4,79}/g) || [];
  return tokens.find(looksLikeSerial) || '';
}

function looksLikeSerial(value) {
  const token = String(value || '').trim();
  return token.length >= 5
    && token.length <= 80
    && !/\s/.test(token)
    && /\d/.test(token)
    && /[A-Za-z._-]/.test(token)
    && !/^https?:/i.test(token)
    && /^[A-Za-z0-9._-]+$/.test(token);
}
