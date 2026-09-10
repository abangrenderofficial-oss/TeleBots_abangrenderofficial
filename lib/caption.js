import { getSetting, recentExamples } from './store.js';

const DEFAULT_RULES = `Extract only the product/model title from the incoming Telegram caption. Translate the title to English if needed. Keep brand names, model numbers, product codes and software/version names unchanged. Remove source credits, hashtags, ads, unrelated descriptions and source links. Return title text only.`;

export async function generateTitle({ caption = '', fileName = '' }) {
  const rules = (await getSetting('title_rules')) || DEFAULT_RULES;
  const learnedRules = (await getSetting('learned_title_rules')) || [];
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) return fallbackTitle(caption, fileName);

  const examples = await recentExamples();
  const exampleText = examples.length
    ? `\n\nExamples of owner corrections:\n${examples.map((e, i) => `${i + 1}. Input: ${e.original_caption}\nCorrect title: ${e.corrected_title}`).join('\n')}`
    : '';
  const learnedText = Array.isArray(learnedRules) && learnedRules.length
    ? `\n\nAdditional rules learned from the owner:\n${learnedRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
    : '';

  const prompt = `Caption:\n${caption || '(no caption)'}\n\nFilename:\n${fileName || '(none)'}`;
  const system = `${rules}${learnedText}${exampleText}`;

  try {
    const text = await callGeminiText({ system, prompt, maxOutputTokens: 160, timeoutMs: 7000 });
    return cleanAiTitle(text) || fallbackTitle(caption, fileName);
  } catch (error) {
    console.error('Title generation AI failed, using fallback:', error);
    return fallbackTitle(caption, fileName);
  }
}

export async function interpretTitleTeaching({ originalCaption = '', fileName = '', currentTitle = '', ownerInstruction = '' }) {
  // Common owner instructions can be learned locally, so teaching still works even if Gemini is slow/down.
  const local = interpretCommonTeaching({ originalCaption, fileName, currentTitle, ownerInstruction });
  if (local) return local;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      correctedTitle: cleanTeachingFallback(ownerInstruction, originalCaption, fileName, currentTitle),
      ruleSummary: 'Ikut correction owner dan simpan hanya product/model title, tanpa hashtag atau footer.',
    };
  }

  const system = `You interpret teaching instructions from the owner of a Telegram content bot.
The owner may explain a rule in informal Malay/English, paste a desired final caption, or paste both instructions and an example.
Your job is NOT to save the whole message as a title.
Identify only the intended product/model title. The title may contain multiple lines, including a serial/model code plus product name.
Never include footer text such as "Tutorial Download", "More collection here", category links, hashtags, source credits, explanations, or phrases like "contoh", "cth", "jadi macam", "delete", "ambil tajuk" in corrected_title.
Then summarize the reusable lesson in one short rule sentence.
Return strict JSON only with this shape:
{"corrected_title":"...","rule_summary":"..."}`;

  const prompt = `SOURCE CAPTION:\n${originalCaption || '(none)'}\n\nFILENAME:\n${fileName || '(none)'}\n\nCURRENT GENERATED TITLE:\n${currentTitle || '(none)'}\n\nOWNER TEACHING MESSAGE:\n${ownerInstruction}`;

  try {
    const raw = await callGeminiText({ system, prompt, maxOutputTokens: 260, timeoutMs: 4500 });
    const parsed = parseTeachingJson(raw);
    if (parsed.correctedTitle) return parsed;
  } catch (error) {
    console.error('Teaching interpretation failed, using local fallback:', error);
  }

  return {
    correctedTitle: cleanTeachingFallback(ownerInstruction, originalCaption, fileName, currentTitle),
    ruleSummary: 'Ikut correction owner sambil kekalkan hanya product/model title dan buang hashtag/footer daripada title.',
  };
}

function interpretCommonTeaching({ originalCaption, fileName, currentTitle, ownerInstruction }) {
  const instruction = String(ownerInstruction || '').toLowerCase();
  const wantsRemoveHashtags = /(hashtag|#)/i.test(instruction) && /(buang|remove|delete|padam|jangan|tak nak)/i.test(instruction);
  const wantsTitleOnly = /(tajuk|title|no\.?\s*siri|nombor\s*siri|serial|model)/i.test(instruction) && /(ambil|keep|kekal|sahaja|saja|only)/i.test(instruction);
  const mentionsFooter = /(tutorial download|more collection|footer|bawah tajuk|ayat di bawah)/i.test(instruction);

  if (!wantsRemoveHashtags && !wantsTitleOnly) return null;

  const title = titleFromSource(originalCaption, fileName, currentTitle);
  const lessons = [];
  if (wantsRemoveHashtags) lessons.push('buang semua hashtag');
  if (wantsTitleOnly) lessons.push('ambil nombor siri/model dan nama product sahaja');
  if (mentionsFooter) lessons.push('footer kekal berasingan dan ditambah automatik di bawah title');

  return {
    correctedTitle: title,
    ruleSummary: capitalizeFirst(`${lessons.join(', ')}.`),
  };
}

async function callGeminiText({ system, prompt, maxOutputTokens = 160, timeoutMs = 7000 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const preferred = String(process.env.GEMINI_MODEL || '').trim();
  const models = [...new Set([
    preferred,
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
  ].filter(Boolean))];
  let lastError = null;

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
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
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens,
              responseMimeType: 'text/plain',
            },
          }),
        },
      ).finally(() => clearTimeout(timer));

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastError = `${model}: ${data?.error?.message || `HTTP ${response.status}`}`;
        continue;
      }

      const text = data?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text || '')
        .join('')
        .trim();
      if (text) return text;
      lastError = `${model}: empty response`;
    } catch (error) {
      lastError = `${model}: ${error?.name === 'AbortError' ? 'request timeout' : (error?.message || 'request failed')}`;
    }
  }

  throw new Error(lastError || 'Gemini request failed');
}

function parseTeachingJson(raw) {
  const cleaned = String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    const data = JSON.parse(cleaned);
    return {
      correctedTitle: cleanAiTitle(data?.corrected_title || ''),
      ruleSummary: String(data?.rule_summary || '').trim().slice(0, 500),
    };
  } catch {
    return { correctedTitle: '', ruleSummary: '' };
  }
}

function cleanTeachingFallback(ownerInstruction, originalCaption, fileName, currentTitle) {
  const source = String(ownerInstruction || '');
  const beforeFooter = source.split(/\n\s*(?:Tutorial Download|More collection here)\s*:?/i)[0];
  const lines = beforeFooter
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.startsWith('#'))
    .filter((x) => !/^(?:kalau|cth|contoh|bawah|atas|just|aku|kau|saya|please|delete|ambil|buang|jadi|kemudian|tambah)/i.test(x));
  if (lines.length) return lines.slice(-2).join('\n').slice(0, 180);

  return titleFromSource(originalCaption, fileName, currentTitle);
}

function titleFromSource(originalCaption, fileName, currentTitle) {
  const captionLines = String(originalCaption || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.startsWith('#'))
    .filter((x) => !/^(?:tutorial download|more collection here)/i.test(x));
  if (captionLines.length) return captionLines.slice(0, 2).join('\n').slice(0, 180);

  const cleanedCurrent = cleanAiTitle(currentTitle);
  if (cleanedCurrent) return cleanedCurrent;
  return fallbackTitle('', fileName);
}

function capitalizeFirst(text) {
  const value = String(text || '').trim();
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

function cleanAiTitle(text) {
  if (!text) return '';
  return String(text)
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^(?:title|tajuk)\s*:\s*/i, '')
    .trim()
    .slice(0, 180);
}

function fallbackTitle(caption, fileName) {
  const usefulLines = String(caption || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.startsWith('#'))
    .filter((x) => !/^(?:tutorial download|more collection here)/i.test(x));
  if (usefulLines.length) return usefulLines.slice(0, 2).join('\n').slice(0, 180);
  if (fileName) return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 180);
  return 'Untitled';
}

export async function buildCaption(title) {
  const footer = await getSetting('caption_footer_html');
  if (!footer) return `<b>${escapeHtml(title)}</b>`;
  return `<b>${escapeHtml(title)}</b>\n\n${footer}`;
}

export function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
