import { escapeHtml } from './caption.js';
import { getQueueItem, getSetting, setSetting, updateQueueItem } from './store.js';

const MEDIA_CONTEXT_PREFIX = 'untitled_media_context_v1:';
const NAME_CACHE_PREFIX = 'untitled_photo_name_v1:';

// Keep this helper isolated: only photos need extra media context for vision naming.
// Documents/files and every existing format rule stay untouched.
export async function rememberUntitledMediaContext({ itemId, media, message }) {
  if (!itemId || media?.kind !== 'photo' || !media?.fileId) return;

  const value = {
    chat_id: String(message?.chat?.id || ''),
    source_message_id: message?.message_id ?? null,
    media_kind: 'photo',
    file_id: media.fileId,
    file_unique_id: media.fileUniqueId || null,
    created_at: new Date().toISOString(),
  };

  await setSetting(`${MEDIA_CONTEXT_PREFIX}${itemId}`, value);
}

// Legacy export name is intentionally kept so no other old code/import breaks.
// Despite the name, this function now ONLY acts on an untitled PHOTO.
export async function maybeAutoNameUntitledDocument({ itemId, chatId }) {
  if (!itemId || !chatId || !process.env.GEMINI_API_KEY || !process.env.TELEGRAM_BOT_TOKEN) return null;

  let item = await getQueueItem(itemId);
  if (!item || item.media_kind !== 'photo') return null;
  if (['SENT', 'SKIPPED'].includes(String(item.status || '').toUpperCase())) return null;
  if (!isUntitledPhoto(item)) return null;

  const context = await getSetting(`${MEDIA_CONTEXT_PREFIX}${item.id}`).catch(() => null);
  if (!context?.file_id) return null;

  const cacheIdentity = String(item.file_unique_id || context.file_unique_id || item.id);
  const cacheKey = `${NAME_CACHE_PREFIX}${fastHash(cacheIdentity)}`;
  let generatedName = await getSetting(cacheKey).catch(() => null);

  if (typeof generatedName !== 'string' || !generatedName.trim()) {
    generatedName = await nameImageWithGemini(context.file_id).catch((error) => {
      console.error('Untitled photo vision naming failed:', error?.message || error);
      return '';
    });
    generatedName = cleanGeneratedName(generatedName);
    if (!generatedName) return null;
    await setSetting(cacheKey, generatedName).catch(() => {});
  } else {
    generatedName = cleanGeneratedName(generatedName);
  }

  // Re-read after AI. If the normal format logic or owner already supplied a real
  // title meanwhile, leave it alone. This is the hard guard that protects old logic.
  item = await getQueueItem(itemId);
  if (!item || item.media_kind !== 'photo' || !isUntitledPhoto(item)) return null;
  if (['SENT', 'SKIPPED'].includes(String(item.status || '').toUpperCase())) return null;

  const oldTitle = String(item.generated_title || '').trim();
  const title = composePhotoTitle(oldTitle, generatedName);
  const finalCaptionHtml = addGeneratedTitleToCaption(item.final_caption_html, oldTitle, title);

  return updateQueueItem(item.id, {
    generated_title: title,
    final_caption_html: finalCaptionHtml,
    caption_replaced: true,
    error_message: null,
  });
}

function isUntitledPhoto(item) {
  const raw = String(item?.generated_title || '').trim();
  if (!raw) return true;

  const lines = raw
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !isEmptyTitleToken(x));

  if (!lines.length) return true;

  // If existing format logic kept only a serial/code, the photo is still missing
  // a human-readable title. Preserve that serial and append the AI name.
  return lines.every(looksLikeSerial);
}

function composePhotoTitle(oldTitle, generatedName) {
  const serialLines = String(oldTitle || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter(looksLikeSerial);

  return [...serialLines, generatedName]
    .filter(Boolean)
    .join('\n')
    .slice(0, 220);
}

function addGeneratedTitleToCaption(finalCaptionHtml, oldTitle, newTitle) {
  const html = String(finalCaptionHtml || '').trim();
  const titleHtml = `<b>${escapeHtml(newTitle)}</b>`;
  if (!html) return titleHtml;

  const old = String(oldTitle || '').trim();
  if (old) {
    const oldTitleHtml = `<b>${escapeHtml(old)}</b>`;
    if (html.startsWith(oldTitleHtml)) {
      return `${titleHtml}${html.slice(oldTitleHtml.length)}`;
    }
  }

  // Existing caption/footer stays exactly as old logic produced it. We only add
  // the generated photo title above it when there was no old title block.
  return `${titleHtml}\n\n${html}`;
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
  const base64 = bytes.toString('base64');
  const mimeType = mimeFromPath(filePath);

  const preferred = String(process.env.GEMINI_MODEL || '').trim();
  const models = [...new Set([
    preferred,
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-2.5-flash-lite',
  ].filter(Boolean))].slice(0, 3);

  const instruction = 'Look at this image and create one short natural English catalog title for the main visible object/product/asset. Return title only, 2 to 6 words. No serial numbers, IDs, quotes, explanation, hashtags, or punctuation at the end. If it is a set of objects, name the set concisely.';
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
              temperature: 0.15,
              maxOutputTokens: 36,
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
    .slice(0, 6)
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

function fastHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
