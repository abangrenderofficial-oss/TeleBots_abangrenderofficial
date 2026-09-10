import { getSetting, recentExamples } from './store.js';

const DEFAULT_RULES = `Extract only the product/model title from the incoming Telegram caption. Translate the title to English if needed. Keep brand names, model numbers, product codes and software/version names unchanged. Remove source credits, hashtags, ads, unrelated descriptions and source links. Return title text only.`;

export async function generateTitle({ caption = '', fileName = '' }) {
  const rules = (await getSetting('title_rules')) || DEFAULT_RULES;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) return fallbackTitle(caption, fileName);

  const examples = await recentExamples();
  const model = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
  const exampleText = examples.length
    ? `\n\nExamples of owner corrections:\n${examples.map((e, i) => `${i + 1}. Input: ${e.original_caption}\nCorrect title: ${e.corrected_title}`).join('\n')}`
    : '';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `${rules}${exampleText}` }],
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Caption:\n${caption || '(no caption)'}\n\nFilename:\n${fileName || '(none)'}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 120,
          responseMimeType: 'text/plain',
        },
      }),
    },
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini title generation failed: ${JSON.stringify(data)}`);
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    .trim();

  return cleanAiTitle(text) || fallbackTitle(caption, fileName);
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
  const firstUsefulLine = String(caption || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find(Boolean);
  if (firstUsefulLine) return firstUsefulLine.slice(0, 180);
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
