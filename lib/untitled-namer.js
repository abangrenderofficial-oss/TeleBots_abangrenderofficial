import { escapeHtml } from './caption.js';
import { getQueueItem, getSetting, setSetting, updateQueueItem } from './store.js';
import { isRecaptionAiBypass, pauseRecaptionForAi } from './ai-gate.js';

const MEDIA_CONTEXT_PREFIX = 'untitled_media_context_v1:';
const NAME_CACHE_PREFIX = 'untitled_photo_name_v2:';

// Photos keep their Telegram file_id so vision can be used only when the normal
// caption/title extractor has nothing useful to work with. Existing format rules
// remain the first source of truth.
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

// Priority is strict: normal caption extraction first; vision is only fallback
// when the photo still has no human-readable title (or only a serial/code).
export async function maybeAutoNameUntitledDocument({ itemId, chatId }) {
  if (!itemId || !chatId || !process.env.TELEGRAM_BOT_TOKEN) return null;

  let item = await getQueueItem(itemId);
  if (!item || item.media_kind !== 'photo') return null;
  if (['SENT', 'SKIPPED'].includes(String(item.status || '').toUpperCase())) return null;

  // Most photos stop here. If caption extraction already produced a real title,
  // vision is never contacted and no AI quota is spent.
  if (!isUntitledPhoto(item)) return null;

  const context = await getSetting(`${MEDIA_CONTEXT_PREFIX}${item.id}`).catch(() => null);
  if (!context?.file_id) return null;

  if (item.recaption_session_id && await isRecaptionAiBypass(item.recaption_session_id)) {
    return null;
  }

  if (!hasVisionProvider()) {
    const error = new Error('Vision unavailable: no configured vision provider');
    if (item.recaption_session_id) {
      await pauseRecaptionForAi({
        sessionId: item.recaption_session_id,
        chatId,
        itemId: item.id,
        kind: 'vision',
        error,
      }).catch(() => {});
    }
    return null;
  }

  const cacheIdentity = String(item.file_unique_id || context.file_unique_id || item.id);
  const cacheKey = `${NAME_CACHE_PREFIX}${fastHash(cacheIdentity)}`;
  let generatedName = await getSetting(cacheKey).catch(() => null);

  if (typeof generatedName !== 'string' || !generatedName.trim()) {
    let result;
    try {
      result = await nameImageWithVisionFallback(context.file_id);
    } catch (error) {
      console.error('Untitled photo vision naming failed:', error?.message || error);
      if (item.recaption_session_id) {
        await pauseRecaptionForAi({
          sessionId: item.recaption_session_id,
          chatId,
          itemId: item.id,
          kind: 'vision',
          error,
        }).catch((pauseError) => {
          console.error('Vision AI pause failed:', pauseError?.message || pauseError);
        });
      }
      return null;
    }

    generatedName = cleanGeneratedName(result?.title || '');
    if (!generatedName) return null;
    await setSetting(cacheKey, generatedName).catch(() => {});
    console.log('Untitled photo vision naming success:', item.source_message_id, result?.provider || 'unknown', generatedName);
  } else {
    generatedName = cleanGeneratedName(generatedName);
  }

  // Re-read after AI. If normal format logic or the owner supplied a real title
  // while vision was running, do not overwrite it.
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

function hasVisionProvider() {
  return Boolean(
    process.env.GROQ_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.GEMINI_API_KEY_2
    || process.env.GEMINI_API_KEY_3
  );
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

  // A serial/model code alone is not a human-readable title. Preserve it and
  // append the object name produced by vision.
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

  // Keep Tutorial Download / More Collection and every existing footer exactly
  // as format logic produced it; only prepend the missing title.
  return `${titleHtml}\n\n${html}`;
}

async function nameImageWithVisionFallback(fileId) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');

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
  const instruction = 'Identify the main visible 3D asset/object in this image. Return one simple natural English catalog title only, 2 to 5 words. Examples: Modern Lounge Chair, Wooden Dining Table, Decorative Wall Mirror, Potted Olive Tree. No brand guessing, no serial number, no explanation, no quotes, no hashtags, no punctuation at the end.';
  const errors = [];

  const groqKey = String(process.env.GROQ_API_KEY || '').trim();
  if (groqKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${groqKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen/qwen3.8-27b',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
            ],
          }],
          temperature: 0.1,
          max_completion_tokens: 32,
          stream: false,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const title = cleanGeneratedName(data?.choices?.[0]?.message?.content || '');
        if (title) return { title, provider: 'groq/qwen3.8-27b' };
        errors.push('groq:empty');
      } else {
        errors.push(`groq:${shortError(data?.error?.message || response.status)}`);
      }
    } catch (error) {
      errors.push(`groq:${error?.name === 'AbortError' ? 'timeout' : shortError(error?.message || 'request failed')}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const keys = [...new Set([
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ].map((x) => String(x || '').trim()).filter(Boolean))];

  const preferred = String(process.env.GEMINI_MODEL || '').trim();
  const models = [...new Set([
    preferred,
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
  ].filter(Boolean))].slice(0, 3);

  for (const model of models) {
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'x-goog-api-key': keys[keyIndex],
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
                temperature: 0.1,
                maxOutputTokens: 32,
                responseMimeType: 'text/plain',
              },
            }),
          },
        );

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          errors.push(`${model}/key${keyIndex + 1}:${shortError(data?.error?.message || response.status)}`);
          continue;
        }

        const raw = data?.candidates?.[0]?.content?.parts?.map((x) => x?.text || '').join('').trim();
        const title = cleanGeneratedName(raw);
        if (title) return { title, provider: `gemini/${model}/key${keyIndex + 1}` };
        errors.push(`${model}/key${keyIndex + 1}:empty`);
      } catch (error) {
        errors.push(`${model}/key${keyIndex + 1}:${error?.name === 'AbortError' ? 'timeout' : shortError(error?.message || 'request failed')}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  throw new Error(`Vision unavailable: ${errors.slice(-8).join(' | ')}`);
}

function shortError(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
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
    .replace(/^(?:title|name|object)\s*:\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.!,:;\-–—]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
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
