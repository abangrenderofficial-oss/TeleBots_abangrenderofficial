import { escapeHtml } from './caption.js';
import { getSetting, setSetting } from './store.js';

const KEY_PREFIX = 'format_remove_words_v1:';

export async function getFormatRemoveTerms(profileId) {
  if (!profileId) return [];
  const value = await getSetting(`${KEY_PREFIX}${profileId}`);
  return normalizeTerms(value);
}

export async function addFormatRemoveTerms(profileId, input) {
  if (!profileId) throw new Error('Format profile tak jumpa');
  const current = await getFormatRemoveTerms(profileId);
  const added = parseInputTerms(input);
  if (!added.length) throw new Error('Tak ada word/ayat untuk dibuang');

  const seen = new Set(current.map((x) => x.toLocaleLowerCase('en')));
  const merged = [...current];
  for (const term of added) {
    const key = term.toLocaleLowerCase('en');
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(term);
    }
  }

  await setSetting(`${KEY_PREFIX}${profileId}`, merged.slice(-40));
  return merged.slice(-40);
}

export async function clearFormatRemoveTerms(profileId) {
  if (!profileId) return [];
  await setSetting(`${KEY_PREFIX}${profileId}`, []);
  return [];
}

export async function applyFormatRemoveTerms(profileId, processed) {
  const terms = await getFormatRemoveTerms(profileId);
  if (!terms.length) return { ...processed, removeTerms: [] };

  const oldTitle = String(processed?.title || '');
  const newTitle = removeTerms(oldTitle, terms);
  let finalCaptionHtml = String(processed?.finalCaptionHtml || '');

  // processMediaWithProfile builds the title as the first <b>...</b> block.
  // Replace only that block so the saved footer/caption stays untouched.
  if (oldTitle && finalCaptionHtml) {
    const oldTitleHtml = `<b>${escapeHtml(oldTitle)}</b>`;
    const newTitleHtml = newTitle ? `<b>${escapeHtml(newTitle)}</b>` : '';
    if (finalCaptionHtml.startsWith(oldTitleHtml)) {
      finalCaptionHtml = `${newTitleHtml}${finalCaptionHtml.slice(oldTitleHtml.length)}`
        .replace(/^\n{2}/, '')
        .trim();
    }
  }

  return {
    ...processed,
    title: newTitle || null,
    finalCaptionHtml: finalCaptionHtml || null,
    removeTerms: terms,
  };
}

export function removeWordButtonLabel(terms = []) {
  const count = normalizeTerms(terms).length;
  return count ? `🧹 Remove Word (${count})` : '🧹 Remove Word';
}

function parseInputTerms(input) {
  const raw = String(input || '').trim();
  if (!raw) return [];
  return normalizeTerms(
    raw.split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

function normalizeTerms(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const term = String(item || '').trim().slice(0, 180);
    if (!term) continue;
    const key = term.toLocaleLowerCase('en');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

function removeTerms(value, terms) {
  let text = String(value || '');
  for (const term of terms || []) {
    if (!term) continue;
    text = text.replace(new RegExp(escapeRegExp(term), 'giu'), ' ');
  }
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,.;:|\-–—]+|[\s,.;:|\-–—]+$/g, '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
