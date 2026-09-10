import { getSetting, recentExamples, setSetting } from './store.js';

const DEFAULT_RULES = `Extract only the product/model title from the incoming Telegram caption. Translate the title to English if needed. Keep brand names, model numbers, product codes and software/version names unchanged. Remove source credits, hashtags, ads, unrelated descriptions and source links. Return title text only.`;

export async function generateTitle({ caption = '', fileName = '' }) {
  const rules = (await getSetting('title_rules')) || DEFAULT_RULES;
  const learnedRules = (await getSetting('learned_title_rules')) || [];
  const apiKey = process.env.GEMINI_API_KEY;
  const examples = await recentExamples(30);

  const familiarity = assessFormatFamiliarity({ caption, fileName, examples });
  await setSetting(
    'format_learning_notice',
    familiarity.known
      ? null
      : {
          unknown: true,
          reason: familiarity.reason,
          signature: familiarity.signature,
          detected_at: new Date().toISOString(),
        },
  ).catch(() => {});

  if (!apiKey) return fallbackTitle(caption, fileName);

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

function assessFormatFamiliarity({ caption, fileName, examples }) {
  const source = String(caption || '').trim();
  const signature = formatSignature(source, fileName);
  const usableExamples = (examples || []).filter((e) => String(e?.original_caption || '').trim());

  if (!usableExamples.length) {
    return {
      known: false,
      signature,
      reason: 'Belum ada contoh learning untuk dibandingkan dengan format ini.',
    };
  }

  let best = 0;
  for (const example of usableExamples) {
    const exampleSignature = formatSignature(String(example.original_caption || ''), '');
    best = Math.max(best, signatureSimilarity(signature, exampleSignature));
  }

  if (best >= 0.82) return { known: true, signature, reason: 'Format hampir sama dengan contoh yang pernah diajar.' };

  return {
    known: false,
    signature,
    reason: 'Struktur caption ini berbeza daripada format yang pernah diajar.',
  };
}

function formatSignature(caption, fileName) {
  const raw = String(caption || '').trim();
  const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const first = lines[0] || String(fileName || '').trim();
  const lineCount = lines.length || (first ? 1 : 0);

  return {
    fileOnly: !raw && Boolean(fileName),
    lineBucket: lineCount <= 1 ? 1 : lineCount === 2 ? 2 : lineCount <= 4 ? 3 : 4,
    hasHashtags: /(^|\s)#[\p{L}\p{N}_-]+/u.test(raw),
    hasUrl: /https?:\/\/|www\./i.test(raw),
    hasAt: /(^|\s)@[A-Za-z0-9_]{3,}/.test(raw),
    hasNonLatin: /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(raw),
    leadingCode: /\d/.test(first) && /^[A-Za-z0-9._\-\s]{4,80}$/.test(first),
    hasEmoji: /[\u{1F300}-\u{1FAFF}]/u.test(raw),
    hasColon: /:/.test(raw),
    hasBullets: /(^|\n)\s*[•▪◦\-*]\s+/m.test(raw),
  };
}

function signatureSimilarity(a, b) {
  const weighted = [
    ['fileOnly', 2.2],
    ['lineBucket', 2.0],
    ['hasHashtags', 2.0],
    ['hasUrl', 1.4],
    ['hasAt', 0.8],
    ['hasNonLatin', 1.5],
    ['leadingCode', 1.8],
    ['hasEmoji', 0.6],
    ['hasColon', 0.5],
    ['hasBullets', 0.6],
  ];
  let score = 0;
  let total = 0;
  for (const [key, weight] of weighted) {
    total += weight;
    if (a[key] === b[key]) score += weight;
  }
  return total ? score / total : 0;
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
