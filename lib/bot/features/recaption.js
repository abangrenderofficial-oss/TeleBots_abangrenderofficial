import { escapeHtml } from '../../caption.js';
import { processMediaWithProfile } from '../../format-profiles.js';
import { applyFormatRemoveTerms } from '../../remove-words.js';
import { getQueueItem, setSetting, updateQueueItem } from '../../store.js';
import { telegram } from '../../telegram.js';
import { translateTitleFailover } from '../../translation-failover.js';
import { maybeSyncSentItem } from './sent-sync.js';

export async function recaptionItemWithProfile(itemId, profile, options = {}) {
  const item = await getQueueItem(itemId);
  if (!item) throw new Error('Item tak jumpa');

  const startedAt = Date.now();
  const needsAi = Boolean(profile?.actions?.translate);
  try {
    // Title extraction stays deterministic/local. Translation is handled by
    // the multi-provider router below so a Gemini outage cannot silently pass
    // the untranslated source title as a success.
    let baseProcessed = await processMediaWithProfile({
      caption: item.original_caption || '',
      fileName: item.file_name || '',
      profile,
      fast: true,
      useAi: false,
    });

    if (needsAi && baseProcessed.title) {
      baseProcessed = await translateProcessedTitle(baseProcessed);
    }

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
    const elapsedMs = Date.now() - startedAt;

    await setSetting(`recaption_last:${item.id}`, {
      ok: true,
      profile_id: String(profile?.id || ''),
      used_ai: needsAi,
      elapsed_ms: elapsedMs,
      validation,
      sync: {
        ok: sync?.ok !== false,
        mode: sync?.mode || null,
        pending: Boolean(sync?.pending),
        synced: Boolean(sync?.synced),
        skipped: sync?.skipped || null,
      },
      at: new Date().toISOString(),
    }).catch(() => {});

    return {
      item: updated,
      processed,
      validation,
      sync,
      elapsed_ms: elapsedMs,
    };
  } catch (error) {
    const message = String(error?.message || error);
    await setSetting(`recaption_last:${item.id}`, {
      ok: false,
      profile_id: String(profile?.id || ''),
      used_ai: needsAi,
      elapsed_ms: Date.now() - startedAt,
      error: message.slice(0, 500),
      at: new Date().toISOString(),
    }).catch(() => {});

    if (needsAi && /translation unavailable|translate failed|translation still contains non-latin/i.test(message)) {
      await telegram('sendMessage', {
        chat_id: item.admin_chat_id,
        text: '⚠️ Translate gagal sementara. Tajuk asal TAK dianggap berjaya translate dan item tak akan dilepaskan sebagai READY sampai translation valid. Cuba semula sekejap lagi.',
      }).catch(() => {});
    }

    throw error;
  }
}

async function translateProcessedTitle(processed) {
  const serial = String(processed?.serial || '').trim();
  const fullTitle = String(processed?.title || '').trim();
  if (!fullTitle) return processed;

  let coreTitle = fullTitle;
  if (serial) {
    const lines = fullTitle.split(/\r?\n/);
    if (String(lines[0] || '').trim().toLowerCase() === serial.toLowerCase()) {
      coreTitle = lines.slice(1).join('\n').trim();
    }
  }

  if (!coreTitle) return processed;
  const translation = await translateTitleFailover(coreTitle);
  const translatedCore = String(translation?.text || '').trim();
  if (!translatedCore) throw new Error('Translation unavailable: provider returned empty title');
  if (hasNonLatinSourceScript(translatedCore)) {
    throw new Error('Translate failed: translation still contains non-Latin source text');
  }

  console.log('Recaption translation success:', translation.provider, translation.model);
  const translatedTitle = [serial, translatedCore]
    .filter(Boolean)
    .join('\n')
    .trim()
    .slice(0, 220);

  const oldWrapped = `<b>${escapeHtml(fullTitle)}</b>`;
  const newWrapped = `<b>${escapeHtml(translatedTitle)}</b>`;
  let finalCaptionHtml = String(processed?.finalCaptionHtml || '');
  if (finalCaptionHtml.includes(oldWrapped)) {
    finalCaptionHtml = finalCaptionHtml.replace(oldWrapped, newWrapped);
  } else if (/^<b>[\s\S]*?<\/b>/.test(finalCaptionHtml)) {
    // Fail-safe for captions whose title wrapper no longer matches byte-for-byte
    // after remove-word/format edits. Replace only the leading title block.
    finalCaptionHtml = finalCaptionHtml.replace(/^<b>[\s\S]*?<\/b>/, newWrapped);
  } else if (!finalCaptionHtml && translatedTitle) {
    finalCaptionHtml = newWrapped;
  }

  return {
    ...processed,
    title: translatedTitle,
    finalCaptionHtml,
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

  if (actions.translate && title.trim() && hasNonLatinSourceScript(title)) {
    errors.push('translation still contains non-Latin source text');
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

function hasNonLatinSourceScript(value) {
  return /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0600-\u06ff\u0e00-\u0e7f]/u.test(String(value || ''));
}
