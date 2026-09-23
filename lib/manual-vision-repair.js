import { waitUntil } from '@vercel/functions';
import { escapeHtml } from './caption.js';
import { getSetting, listQueueItems, updateQueueItem } from './store.js';
import { telegram } from './telegram.js';

const TOKEN = 'ftwEe5WhbbMydaNZszd0Vfo0qdSBg0E0';
const CHAT_ID = 6749355196;
const START_MESSAGE_ID = 4843;
const END_MESSAGE_ID = 4899;
const SELF_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/health';

export async function runManualVisionRepair(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (String(req.query?.k || '') !== TOKEN) return res.status(403).json({ ok: false, error: 'forbidden' });

  const rows = await listQueueItems(CHAT_ID, 1000);
  const target = (rows || [])
    .filter((item) => item.media_kind === 'photo')
    .filter((item) => Number(item.source_message_id) >= START_MESSAGE_ID && Number(item.source_message_id) <= END_MESSAGE_ID)
    .filter((item) => !String(item.original_caption || '').trim())
    .filter((item) => !String(item.generated_title || '').trim())
    .filter((item) => !['SENT', 'SKIPPED'].includes(String(item.status || '').toUpperCase()))
    .sort((a, b) => Number(a.source_message_id) - Number(b.source_message_id))[0];

  if (!target) return res.status(200).json({ ok: true, done: true, message: 'no untitled photos remain' });

  const context = await getSetting(`untitled_media_context_v1:${target.id}`).catch(() => null);
  if (!context?.file_id) {
    await updateQueueItem(target.id, { error_message: 'Manual vision repair: Telegram file context missing' }).catch(() => {});
    return res.status(200).json({ ok: false, done: false, source_message_id: target.source_message_id, error: 'missing file context' });
  }

  try {
    const result = await nameTelegramImage(context.file_id);
    const title = result.title;
    const oldHtml = String(target.final_caption_html || '').trim();
    const titleHtml = `<b>${escapeHtml(title)}</b>`;
    const finalCaptionHtml = oldHtml ? `${titleHtml}\n\n${oldHtml}` : titleHtml;

    const updated = await updateQueueItem(target.id, {
      generated_title: title,
      final_caption_html: finalCaptionHtml,
      caption_replaced: true,
      status: 'READY',
      error_message: null,
    });

    if (updated?.preview_message_id) {
      await telegram('editMessageCaption', {
        chat_id: CHAT_ID,
        message_id: updated.preview_message_id,
        caption: updated.final_caption_html || '',
        parse_mode: 'HTML',
      }).catch((error) => console.error('Manual vision preview update failed:', target.source_message_id, error?.message || error));
    }

    console.log('Manual vision repair success:', target.source_message_id, result.provider, title);
    waitUntil(fetch(`${SELF_URL}?repair_vision=1&k=${encodeURIComponent(TOKEN)}`).catch((error) => {
      console.error('Manual vision continuation failed:', error?.message || error);
    }));

    return res.status(200).json({
      ok: true,
      done: false,
      source_message_id: target.source_message_id,
      provider: result.provider,
      title,
    });
  } catch (error) {
    const message = String(error?.message || error).slice(0, 900);
    await updateQueueItem(target.id, { error_message: `Manual vision repair: ${message}` }).catch(() => {});
    console.error('Manual vision repair failed:', target.source_message_id, message);
    return res.status(200).json({ ok: false, done: false, source_message_id: target.source_message_id, error: message });
  }
}

async function nameTelegramImage(fileId) {
  const telegramToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!telegramToken) throw new Error('TELEGRAM_BOT_TOKEN missing');

  const fileInfoResponse = await fetch(`https://api.telegram.org/bot${telegramToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const fileInfo = await fileInfoResponse.json().catch(() => ({}));
  if (!fileInfoResponse.ok || !fileInfo?.ok || !fileInfo?.result?.file_path) {
    throw new Error(fileInfo?.description || `Telegram getFile failed ${fileInfoResponse.status}`);
  }

  const filePath = fileInfo.result.file_path;
  const imageResponse = await fetch(`https://api.telegram.org/file/bot${telegramToken}/${filePath}`);
  if (!imageResponse.ok) throw new Error(`Telegram image download failed ${imageResponse.status}`);

  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  const base64 = bytes.toString('base64');
  const mimeType = mimeFromPath(filePath);
  const instruction = 'Identify the main visible 3D asset/object in this image. Return one simple natural English catalog name only, 2 to 5 words. Examples: Modern Lounge Chair, Wooden Dining Table, Decorative Wall Mirror, Potted Olive Tree. No brand guessing, no serial number, no explanation, no quotes, no punctuation at the end.';
  const errors = [];

  const groqKey = String(process.env.GROQ_API_KEY || '').trim();
  if (groqKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
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
        const raw = data?.choices?.[0]?.message?.content;
        const cleaned = cleanName(raw);
        if (cleaned) return { title: cleaned, provider: 'groq/qwen3.8-27b' };
        errors.push('groq:empty');
      } else {
        errors.push(`groq:${data?.error?.message || response.status}`);
      }
    } catch (error) {
      errors.push(`groq:${error?.name === 'AbortError' ? 'timeout' : (error?.message || 'failed')}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const keys = [...new Set([
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ].map((x) => String(x || '').trim()).filter(Boolean))];
  const models = [...new Set([
    String(process.env.GEMINI_MODEL || '').trim(),
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
  ].filter(Boolean))].slice(0, 3);

  for (const model of models) {
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'x-goog-api-key': keys[keyIndex],
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: base64 } }, { text: instruction }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 28, responseMimeType: 'text/plain' },
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          errors.push(`${model}/key${keyIndex + 1}:${data?.error?.message || response.status}`);
          continue;
        }
        const raw = data?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('').trim();
        const cleaned = cleanName(raw);
        if (cleaned) return { title: cleaned, provider: `gemini/${model}/key${keyIndex + 1}` };
        errors.push(`${model}/key${keyIndex + 1}:empty`);
      } catch (error) {
        errors.push(`${model}/key${keyIndex + 1}:${error?.name === 'AbortError' ? 'timeout' : (error?.message || 'failed')}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  throw new Error(`Vision unavailable: ${errors.slice(-8).join(' | ')}`);
}

function cleanName(value) {
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
    .slice(0, 80);
}

function mimeFromPath(path) {
  const lower = String(path || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}
