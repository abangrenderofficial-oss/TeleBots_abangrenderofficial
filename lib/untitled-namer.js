import { escapeHtml } from './caption.js';
import { getQueueItem, getSetting, listQueueItems, setSetting, updateQueueItem } from './store.js';

const MEDIA_CONTEXT_PREFIX = 'untitled_media_context_v1:';
const NAME_CACHE_PREFIX = 'untitled_vision_name_v1:';
const PAIR_WINDOW_MS = 3 * 60 * 1000;
const MAX_MESSAGE_DISTANCE = 3;

export async function rememberUntitledMediaContext({ itemId, media, message }) {
  if (!itemId || !message?.chat?.id) return;
  const value = {
    chat_id: String(message.chat.id),
    source_message_id: message.message_id ?? null,
    media_kind: media?.kind || 'other',
    file_id: media?.fileId || null,
    file_unique_id: media?.fileUniqueId || null,
    media_group_id: message.media_group_id || null,
    caption: message.caption || '',
    created_at: new Date().toISOString(),
  };
  await setSetting(`${MEDIA_CONTEXT_PREFIX}${itemId}`, value);
}

export async function maybeAutoNameUntitledDocument({ itemId, chatId }) {
  if (!itemId || !chatId || !process.env.GEMINI_API_KEY || !process.env.TELEGRAM_BOT_TOKEN) return null;

  // Give the same forwarded burst a tiny chance to register nearby photo rows.
  // This runs after the fast preview already appeared, so it never blocks first preview speed.
  await sleep(220);

  let item = await getQueueItem(itemId);
  if (!item || item.media_kind !== 'document') return null;
  if (['SENT', 'SKIPPED'].includes(String(item.status || '').toUpperCase())) return null;
  if (!isUntitledItem(item)) return null;

  const photo = await findPairedPhoto(item, chatId);
  if (!photo) return null;

  const photoContext = await getSetting(`${MEDIA_CONTEXT_PREFIX}${photo.id}`).catch(() => null);
  if (!photoContext?.file_id) return null;

  const cacheKey = `${NAME_CACHE_PREFIX}${fastHash(String(photo.file_unique_id || photoContext.file_unique_id || photo.id))}`;
  let generatedName = await getSetting(cacheKey).catch(() => null);

  if (typeof generatedName !== 'string' || !generatedName.trim()) {
    generatedName = await nameImageWithGemini(photoContext.file_id).catch((error) => {
      console.error('Untitled vision naming failed:', error?.message || error);
      return '';
    });
    generatedName = cleanGeneratedName(generatedName);
    if (!generatedName) return null;
    await setSetting(cacheKey, generatedName).catch(() => {});
  } else {
    generatedName = cleanGeneratedName(generatedName);
  }

  // Re-read right before writing: if normal logic/user edits already supplied a title,
  // do absolutely nothing. This keeps the feature isolated to truly untitled files.
  item = await getQueueItem(itemId);
  if (!item || !isUntitledItem(item)) return null;
  if (['SENT', 'SKIPPED'].includes(String(item.status || '').toUpperCase())) return null;

  const title = composeTitle(item, generatedName);
  const finalCaptionHtml = replaceLeadingTitleBlock(item.final_caption_html, title);

  return updateQueueItem(item.id, {
    generated_title: title,
    final_caption_html: finalCaptionHtml,
    caption_replaced: true,
    error_message: null,
  });
}

function isUntitledItem(item) {
  const raw = String(item?.generated_title || '').trim();
  if (!raw) return true;

  const meaningful = raw
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !isEmptyTitleToken(x))
    .filter((x) => !looksLikeSerial(x));

  if (!meaningful.length) return true;

  const fileStem = String(item?.file_name || '').replace(/\.[^.]+$/, '').trim();
  if (meaningful.length === 1 && fileStem && normalize(meaningful[0]) === normalize(fileStem) && looksLikeSerial(fileStem)) {
    return true;
  }

  return false;
}

async function findPairedPhoto(item, chatId) {
  const rows = await listQueueItems(chatId, 160);
  const currentAt = Date.parse(item.created_at || 0);
  const currentMessage = Number(item.source_message_id);
  const currentSerials = extractSerials([item.generated_title, item.file_name, item.original_caption].filter(Boolean).join('\n'));
  const currentContext = await getSetting(`${MEDIA_CONTEXT_PREFIX}${item.id}`).catch(() => null);

  const candidates = (rows || [])
    .filter((row) => row.media_kind === 'photo')
    .filter((row) => String(row.admin_chat_id) === String(chatId))
    .map((row) => {
      const rowAt = Date.parse(row.created_at || 0);
      const rowMessage = Number(row.source_message_id);
      const age = Number.isFinite(currentAt) && Number.isFinite(rowAt) ? Math.abs(currentAt - rowAt) : Infinity;
      const distance = Number.isFinite(currentMessage) && Number.isFinite(rowMessage)
        ? Math.abs(currentMessage - rowMessage)
        : Infinity;
      const serials = extractSerials([row.generated_title, row.file_name, row.original_caption].filter(Boolean).join('\n'));
      const sameSerial = currentSerials.some((serial) => serials.includes(serial));
      return { row, age, distance, sameSerial };
    })
    .filter((x) => x.age <= PAIR_WINDOW_MS)
    .sort((a, b) => {
      if (a.sameSerial !== b.sameSerial) return a.sameSerial ? -1 : 1;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.age - b.age;
    });

  for (const candidate of candidates.slice(0, 8)) {
    const context = await getSetting(`${MEDIA_CONTEXT_PREFIX}${candidate.row.id}`).catch(() => null);
    if (!context?.file_id) continue;

    const sameMediaGroup = Boolean(
      currentContext?.media_group_id
      && context.media_group_id
      && String(currentContext.media_group_id) === String(context.media_group_id)
    );

    if (candidate.sameSerial || sameMediaGroup || candidate.distance <= MAX_MESSAGE_DISTANCE) {
      return candidate.row;
    }
  }

  return null;
}

async function nameImageWithGemini(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const apiKey = process.env.GEMINI_API_KEY;
  const fileInfoResponse = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const fileInfo = await fileInfoResponse.json().catch(() => ({}));
  if (!fileInfoResponse.ok || !fileInfo?.ok || !fileInfo?.result?.file_path) {
    throw new Error(fileInfo?.description || 'Telegram getFile failed');
  }

  const filePath = fileInfo.result.file_path;
  const imageResponse = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!imageResponse.ok) throw new Error(`Telegram image download failed (${imageResponse.status})`);
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  const mimeType = mimeFromPath(filePath);
  const base64 = bytes.toString('base64');

  const preferred = String(process.env.GEMINI_MODEL || '').trim();
  const models = [...new Set([
    preferred,
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-2.5-flash-lite',
  ].filter(Boolean))].slice(0, 3);

  const instruction = 'Name the main product, object, furniture, decor, plant, food, or 3D asset shown in this image. Return one short natural English catalog title only, 2 to 6 words. Do not include serial numbers, IDs, file names, quotes, explanations, the words image/photo/3D model, or punctuation at the end. If several objects form one set, name the set concisely.';
  let lastError = '';

  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4200);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'x-goog-api-key': apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { inlineData: { mimeType, data: base64 } },
                { text: instruction },
              ],
            }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 40,
              responseMimeType: 'text/plain',
            },
          }),
        },
      );
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
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(lastError || 'Gemini vision failed');
}

function composeTitle(item, generatedName) {
  const serial = extractSerials([item.generated_title, item.file_name, item.original_caption].filter(Boolean).join('\n'))[0] || '';
  return [serial, generatedName].filter(Boolean).join('\n').slice(0, 220);
}

function replaceLeadingTitleBlock(finalCaptionHtml, title) {
  const html = String(finalCaptionHtml || '').trim();
  const titleHtml = `<b>${escapeHtml(title)}</b>`;
  if (!html) return titleHtml;
  if (/^<b>[\s\S]*?<\/b>/.test(html)) return html.replace(/^<b>[\s\S]*?<\/b>/, titleHtml);
  return `${titleHtml}\n\n${html}`;
}

function extractSerials(text) {
  const tokens = String(text || '').match(/[A-Za-z0-9][A-Za-z0-9._-]{4,79}/g) || [];
  return [...new Set(tokens
    .map((x) => x.replace(/^[-_.]+|[-_.]+$/g, ''))
    .filter(looksLikeSerial)
    .map((x) => x.toLowerCase()))];
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

function isEmptyTitleToken(value) {
  return /^(?:\(?none\)?|\(?untitled\)?|no\s*title|n\/?a|null|undefined|-)$/i.test(String(value || '').trim());
}

function cleanGeneratedName(value) {
  return String(value || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^(?:title|name)\s*:\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.!,:;\-–—]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 7)
    .join(' ')
    .slice(0, 100);
}

function mimeFromPath(path) {
  const lower = String(path || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
