import { escapeHtml } from './caption.js';
import { getSetting, setSetting } from './store.js';

const PROFILE_KEY = 'format_profiles_v1';
const ITEM_CONTEXT_PREFIX = 'format_item_v1:';
const TITLE_CACHE_PREFIX = 'format_title_cache_v1:';
const PROFILE_MEMORY_TTL_MS = 60_000;
const FOOTER_MEMORY_TTL_MS = 60_000;
const DEFAULT_ACTIONS = {
  take_title: true,
  take_serial: false,
  translate: false,
  remove_hashtags: true,
  add_footer: true,
};

let profileMemory = null;
let profileMemoryAt = 0;
let footerMemory = null;
let footerMemoryAt = 0;
const itemContextMemory = new Map();
const titleMemory = new Map();

export async function resolveFormatProfile({ caption = '', fileName = '', mediaKind = 'other' }) {
  const signature = buildFormatSignature({ caption, fileName, mediaKind });
  const profiles = await listFormatProfiles();

  let best = null;
  for (const profile of profiles) {
    const score = signatureSimilarity(signature, profile.signature || {});
    if (!best || score > best.score) best = { profile, score };
  }

  if (best && best.score >= 0.86) {
    return { profile: normalizeProfile(best.profile), isNew: false, similarity: best.score, signature };
  }

  const globalFooter = await getGlobalFooter();
  const noCaption = !String(caption || '').trim();
  const profile = normalizeProfile({
    id: makeProfileId(),
    name: nextFormatName(profiles.length),
    signature,
    actions: {
      ...DEFAULT_ACTIONS,
      take_title: !noCaption,
      add_footer: Boolean(globalFooter),
    },
    footer_html: null,
    learned: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await saveProfiles([...profiles, profile]);
  return { profile, isNew: true, similarity: best?.score || 0, signature };
}

export async function listFormatProfiles() {
  if (profileMemory && (Date.now() - profileMemoryAt) < PROFILE_MEMORY_TTL_MS) {
    return profileMemory.map(normalizeProfile);
  }

  const value = await getSetting(PROFILE_KEY);
  profileMemory = Array.isArray(value) ? value.map(normalizeProfile) : [];
  profileMemoryAt = Date.now();
  return profileMemory.map(normalizeProfile);
}

export async function getFormatProfile(profileId) {
  const profiles = await listFormatProfiles();
  return profiles.find((x) => x.id === profileId) || null;
}

export async function saveItemFormatContext(itemId, context) {
  if (!itemId) return;
  const value = {
    ...context,
    updated_at: new Date().toISOString(),
  };
  itemContextMemory.set(String(itemId), value);
  return setSetting(`${ITEM_CONTEXT_PREFIX}${itemId}`, value);
}

export async function getItemFormatContext(itemId) {
  if (!itemId) return null;
  const key = String(itemId);
  if (itemContextMemory.has(key)) return itemContextMemory.get(key);
  const value = await getSetting(`${ITEM_CONTEXT_PREFIX}${itemId}`);
  if (value) itemContextMemory.set(key, value);
  return value;
}

export async function getProfileForItem(item) {
  if (!item) return null;
  const context = await getItemFormatContext(item.id);
  if (context?.profile_id) {
    const profile = await getFormatProfile(context.profile_id);
    if (profile) return profile;
  }

  const resolved = await resolveFormatProfile({
    caption: item.original_caption || '',
    fileName: item.file_name || '',
    mediaKind: item.media_kind || 'other',
  });
  await saveItemFormatContext(item.id, {
    profile_id: resolved.profile.id,
    signature: resolved.signature,
  });
  return resolved.profile;
}

export async function toggleFormatOption(profileId, option) {
  const allowed = new Set(['take_title', 'take_serial', 'translate', 'remove_hashtags', 'add_footer']);
  if (!allowed.has(option)) throw new Error('Format option tak dikenali');

  const profiles = await listFormatProfiles();
  const index = profiles.findIndex((x) => x.id === profileId);
  if (index < 0) throw new Error('Format profile tak jumpa');

  const profile = normalizeProfile(profiles[index]);
  profile.actions[option] = !profile.actions[option];

  if (option === 'translate' && profile.actions.translate) profile.actions.take_title = true;

  profile.learned = true;
  profile.updated_at = new Date().toISOString();
  profiles[index] = profile;
  await saveProfiles(profiles);
  return profile;
}

export async function setFormatFooter(profileId, footerHtml) {
  const profiles = await listFormatProfiles();
  const index = profiles.findIndex((x) => x.id === profileId);
  if (index < 0) throw new Error('Format profile tak jumpa');

  const profile = normalizeProfile(profiles[index]);
  profile.footer_html = String(footerHtml || '').trim() || null;
  profile.actions.add_footer = Boolean(profile.footer_html);
  profile.learned = true;
  profile.updated_at = new Date().toISOString();
  profiles[index] = profile;
  await saveProfiles(profiles);
  return profile;
}

export async function processMediaWithProfile({
  caption = '',
  fileName = '',
  profile,
  fast = false,
  useAi = true,
}) {
  const p = normalizeProfile(profile);
  const actions = p.actions;
  let title = '';

  if (actions.take_title) {
    if (fast || !useAi) {
      title = extractTitleFast({
        caption,
        fileName,
        translate: actions.translate,
        removeHashtags: actions.remove_hashtags,
      });
    } else {
      title = await extractTitleForProfile({
        caption,
        fileName,
        translate: actions.translate,
        removeHashtags: actions.remove_hashtags,
      });
    }
  }

  const serial = actions.take_serial ? extractSerialCandidate(caption, fileName) : '';
  if (serial) title = combineSerialAndTitle(serial, title);

  let footerHtml = '';
  if (actions.add_footer) {
    footerHtml = p.footer_html || (fast ? getCachedGlobalFooter() : await getGlobalFooter()) || '';
  }

  const finalCaptionHtml = buildProfileCaption(title, footerHtml);
  return {
    title,
    serial: serial || null,
    finalCaptionHtml,
    profile: p,
  };
}

export function formatProfileKeyboardRows(profile, itemId) {
  const p = normalizeProfile(profile);
  const on = (value) => (value ? '✅' : '⬜');
  return [
    [{ text: `🧠 ${p.name}${p.learned ? '' : ' · BARU'}`, callback_data: 'noop' }],
    [
      { text: `${on(p.actions.take_title)} Tajuk`, callback_data: `fmt_title:${itemId}` },
      { text: `${on(p.actions.take_serial)} No Siri`, callback_data: `fmt_serial:${itemId}` },
    ],
    [
      { text: `${on(p.actions.translate)} Translate`, callback_data: `fmt_translate:${itemId}` },
      { text: `${on(p.actions.remove_hashtags)} Buang #`, callback_data: `fmt_hashtags:${itemId}` },
    ],
    [
      { text: `${on(p.actions.add_footer)} Tambah Caption`, callback_data: `fmt_footer:${itemId}` },
      { text: '✏️ Ubah Caption', callback_data: `fmt_editfooter:${itemId}` },
    ],
    [{ text: '✅ SEND', callback_data: `send:${itemId}` }],
  ];
}

export function profileOptionFromCallback(action) {
  const map = {
    fmt_title: 'take_title',
    fmt_serial: 'take_serial',
    fmt_translate: 'translate',
    fmt_hashtags: 'remove_hashtags',
    fmt_footer: 'add_footer',
  };
  return map[action] || null;
}

export function buildFormatSignature({ caption = '', fileName = '', mediaKind = 'other' }) {
  const raw = String(caption || '').trim();
  const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const first = lines[0] || '';
  const lineCount = lines.length;

  return {
    media_kind: String(mediaKind || 'other'),
    no_caption: !raw,
    line_bucket: lineCount === 0 ? 0 : lineCount === 1 ? 1 : lineCount === 2 ? 2 : lineCount <= 4 ? 3 : 4,
    has_hashtag: /(^|\s)#[\p{L}\p{N}_-]+/u.test(raw),
    has_url: /https?:\/\/|www\./i.test(raw),
    has_at: /(^|\s)@[A-Za-z0-9_]{3,}/.test(raw),
    has_non_latin: /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(raw),
    leading_serial: looksLikeSerial(first),
    has_emoji: /[\u{1F300}-\u{1FAFF}]/u.test(raw),
    has_colon: /:/.test(raw),
    has_bullets: /(^|\n)\s*[•▪◦\-*]\s+/m.test(raw),
    has_filename: Boolean(String(fileName || '').trim()),
  };
}

function signatureSimilarity(a, b) {
  if (a.no_caption !== b.no_caption) return 0;
  const weights = [
    ['media_kind', 1.2],
    ['no_caption', 4.0],
    ['line_bucket', 2.2],
    ['has_hashtag', 2.0],
    ['has_url', 1.4],
    ['has_at', 0.8],
    ['has_non_latin', 1.5],
    ['leading_serial', 2.4],
    ['has_emoji', 0.7],
    ['has_colon', 0.5],
    ['has_bullets', 0.8],
    ['has_filename', 0.6],
  ];
  let hit = 0;
  let total = 0;
  for (const [key, weight] of weights) {
    total += weight;
    if (a[key] === b[key]) hit += weight;
  }
  return total ? hit / total : 0;
}

function extractTitleFast({ caption, fileName, translate, removeHashtags }) {
  const cleanedCaption = removeHashtags ? stripHashtags(caption) : String(caption || '');
  const cacheKey = makeTitleCacheKey({
    caption: cleanedCaption,
    fileName,
    translate,
    removeHashtags,
  });

  if (titleMemory.has(cacheKey)) return titleMemory.get(cacheKey);
  return localTitle(cleanedCaption, fileName);
}

async function extractTitleForProfile({ caption, fileName, translate, removeHashtags }) {
  const cleanedCaption = removeHashtags ? stripHashtags(caption) : String(caption || '');
  const cacheKey = makeTitleCacheKey({
    caption: cleanedCaption,
    fileName,
    translate,
    removeHashtags,
  });

  if (titleMemory.has(cacheKey)) return titleMemory.get(cacheKey);

  const persisted = await getSetting(cacheKey).catch(() => null);
  if (typeof persisted === 'string' && persisted.trim()) {
    const value = cleanTitle(persisted);
    titleMemory.set(cacheKey, value);
    return value;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const value = localTitle(cleanedCaption, fileName);
    titleMemory.set(cacheKey, value);
    return value;
  }

  const system = `Extract only the real product/model title from an incoming Telegram caption or filename.
Do not include footer text, ads, source credits, links, handles, hashtags, explanatory sentences, or a standalone serial/code line.
Preserve brand names, model numbers, product codes, software names and versions.
${translate ? 'Translate the product title to natural English when it is not English. Do not translate brand/model codes.' : 'Do NOT translate. Keep the product title in its original language.'}
Return title text only. Maximum two lines.`;
  const prompt = `CAPTION:\n${cleanedCaption || '(no caption)'}\n\nFILENAME:\n${fileName || '(none)'}`;

  try {
    const text = await callGeminiText(system, prompt);
    const value = cleanTitle(text) || localTitle(cleanedCaption, fileName);
    titleMemory.set(cacheKey, value);
    await setSetting(cacheKey, value).catch(() => {});
    return value;
  } catch (error) {
    console.error('Format profile title extraction fallback:', error?.message || error);
    const value = localTitle(cleanedCaption, fileName);
    titleMemory.set(cacheKey, value);
    return value;
  }
}

function makeTitleCacheKey({ caption, fileName, translate, removeHashtags }) {
  const source = JSON.stringify({
    c: String(caption || ''),
    f: String(fileName || ''),
    t: Boolean(translate),
    h: Boolean(removeHashtags),
  });
  return `${TITLE_CACHE_PREFIX}${fastHash(source)}`;
}

function fastHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function callGeminiText(system, prompt) {
  const preferred = String(process.env.GEMINI_MODEL || '').trim();
  const models = [...new Set([
    preferred,
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-2.5-flash-lite',
  ].filter(Boolean))];
  let lastError = '';

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5500);
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'x-goog-api-key': process.env.GEMINI_API_KEY,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.15,
              maxOutputTokens: 140,
              responseMimeType: 'text/plain',
            },
          }),
        },
      ).finally(() => clearTimeout(timer));

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastError = data?.error?.message || `HTTP ${response.status}`;
        continue;
      }
      const text = data?.candidates?.[0]?.content?.parts?.map((x) => x?.text || '').join('').trim();
      if (text) return text;
      lastError = 'empty response';
    } catch (error) {
      lastError = error?.name === 'AbortError' ? 'timeout' : (error?.message || 'request failed');
    }
  }
  throw new Error(lastError || 'Gemini failed');
}

function localTitle(caption, fileName) {
  const lines = String(caption || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.startsWith('#'))
    .filter((x) => !/^(?:tutorial download|more collection here)/i.test(x))
    .filter((x) => !looksLikeSerial(x));
  if (lines.length) return cleanTitle(lines.slice(0, 2).join('\n'));
  if (fileName) return cleanTitle(String(fileName).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
  return '';
}

function extractSerialCandidate(caption, fileName = '') {
  const lines = String(caption || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.startsWith('#'));
  if (lines[0] && looksLikeSerial(lines[0])) return lines[0];

  const source = `${caption || ''}\n${fileName || ''}`;
  const tokens = source.match(/[A-Za-z0-9][A-Za-z0-9._-]{4,79}/g) || [];
  return tokens.find(looksLikeSerial) || '';
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

function combineSerialAndTitle(serial, title) {
  const serialValue = String(serial || '').trim();
  const titleLines = String(title || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x.toLowerCase() !== serialValue.toLowerCase());
  return [serialValue, ...titleLines].filter(Boolean).join('\n').slice(0, 220);
}

function buildProfileCaption(title, footerHtml) {
  const clean = String(title || '').trim();
  const footer = String(footerHtml || '').trim();
  if (clean && footer) return `<b>${escapeHtml(clean)}</b>\n\n${footer}`;
  if (clean) return `<b>${escapeHtml(clean)}</b>`;
  return footer;
}

function stripHashtags(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^(?:title|tajuk)\s*:\s*/i, '')
    .split(/\n\s*(?:Tutorial Download|More collection here)\s*:?/i)[0]
    .trim()
    .slice(0, 220);
}

function getCachedGlobalFooter() {
  if ((Date.now() - footerMemoryAt) >= FOOTER_MEMORY_TTL_MS) return '';
  return String(footerMemory || '');
}

async function getGlobalFooter() {
  if ((Date.now() - footerMemoryAt) < FOOTER_MEMORY_TTL_MS) {
    return String(footerMemory || '');
  }
  footerMemory = await getSetting('caption_footer_html').catch(() => null);
  footerMemoryAt = Date.now();
  return String(footerMemory || '');
}

function normalizeProfile(profile) {
  return {
    id: String(profile?.id || makeProfileId()),
    name: String(profile?.name || 'Format'),
    signature: profile?.signature && typeof profile.signature === 'object' ? profile.signature : {},
    actions: { ...DEFAULT_ACTIONS, ...(profile?.actions || {}) },
    footer_html: profile?.footer_html || null,
    learned: Boolean(profile?.learned),
    created_at: profile?.created_at || new Date().toISOString(),
    updated_at: profile?.updated_at || new Date().toISOString(),
  };
}

async function saveProfiles(profiles) {
  const normalized = (profiles || []).map(normalizeProfile).slice(-120);
  profileMemory = normalized;
  profileMemoryAt = Date.now();
  return setSetting(PROFILE_KEY, normalized);
}

function makeProfileId() {
  return `fmt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function nextFormatName(index) {
  let n = Number(index) || 0;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Format ${label}`;
}
