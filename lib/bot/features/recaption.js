import { escapeHtml } from '../../caption.js';
import { processMediaWithProfile } from '../../format-profiles.js';
import { applyFormatRemoveTerms } from '../../remove-words.js';
import { getQueueItem, setSetting, updateQueueItem } from '../../store.js';
import { telegram } from '../../telegram.js';
import { maybeSyncSentItem } from './sent-sync.js';

export async function recaptionItemWithProfile(itemId, profile, options = {}) {
  const item = await getQueueItem(itemId);
  if (!item) throw new Error('Item tak jumpa');

  const startedAt = Date.now();
  const needsAi = Boolean(profile?.actions?.translate);
  try {
    // Keep title extraction deterministic/local. If Translate is ON, translation
    // is handled separately through the current Gemini Interactions API below.
    // This avoids the old generateContent fallback silently returning the same
    // untranslated title when a model is overloaded.
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

    if (needsAi && /translation unavailable|translate failed/i.test(message)) {
      await telegram('sendMessage', {
        chat_id: item.admin_chat_id,
        text: '⚠️ Translate gagal sementara sebab semua model translation tengah busy/timeout. Tajuk asal TAK dianggap berjaya translate dan tak akan dicache. Cuba Translate semula sekejap lagi.',
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
  const translatedCore = await translateTitleWithInteractions(coreTitle);
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
  } else if (!finalCaptionHtml && translatedTitle) {
    finalCaptionHtml = newWrapped;
  }

  return {
    ...processed,
    title: translatedTitle,
    finalCaptionHtml,
  };
}

async function translateTitleWithInteractions(title) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('Translation unavailable: GEMINI_API_KEY missing');

  const preferred = String(process.env.GEMINI_TRANSLATE_MODEL || '').trim();
  const models = [...new Set([
    preferred,
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
  ].filter(Boolean))];
  const errors = [];

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), model.includes('flash-lite') ? 11_000 : 8_000);
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-goog-api-key': apiKey,
          'content-type': 'application/json',
          'Api-Revision': '2026-05-20',
        },
        body: JSON.stringify({
          model,
          system_instruction: 'Translate the supplied product/model title to natural English. Preserve brand names, model numbers, product codes, software names, and version numbers exactly. If it is already natural English, return it unchanged. Return only the translated title, no explanation.',
          input: title,
        }),
      }).finally(() => clearTimeout(timer));

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        errors.push(`${model}: ${data?.error?.message || `HTTP ${response.status}`}`);
        continue;
      }

      const text = interactionText(data);
      if (!text) {
        errors.push(`${model}: empty response (${data?.status || 'unknown status'})`);
        continue;
      }

      const cleaned = cleanTranslation(text);
      if (!cleaned) {
        errors.push(`${model}: empty cleaned translation`);
        continue;
      }

      console.log('Recaption translation success:', model);
      return cleaned;
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'timeout' : (error?.message || 'request failed');
      errors.push(`${model}: ${reason}`);
    }
  }

  throw new Error(`Translation unavailable: ${errors.join(' | ').slice(0, 900)}`);
}

function interactionText(data) {
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  const fromSteps = steps
    .filter((step) => step?.type === 'model_output')
    .flatMap((step) => Array.isArray(step?.content) ? step.content : [])
    .filter((part) => part?.type === 'text' && part?.text)
    .map((part) => part.text)
    .join('')
    .trim();
  if (fromSteps) return fromSteps;

  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  return outputs
    .filter((part) => part?.type === 'text' && part?.text)
    .map((part) => part.text)
    .join('')
    .trim();
}

function cleanTranslation(value) {
  return String(value || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^(?:translation|translated title|title)\s*:\s*/i, '')
    .trim()
    .slice(0, 220);
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
