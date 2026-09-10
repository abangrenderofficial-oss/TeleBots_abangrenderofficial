import { getSetting, recentExamples } from './store.js';

const DEFAULT_RULES = `Extract only the product/model title from the incoming Telegram caption. Translate the title to English if needed. Keep brand names, model numbers, product codes and software/version names unchanged. Remove source credits, hashtags, ads, unrelated descriptions and source links. Return title text only.`;

export async function generateTitle({ caption = '', fileName = '' }) {
  const rules = (await getSetting('title_rules')) || DEFAULT_RULES;
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) return fallbackTitle(caption, fileName);

  const examples = await recentExamples();
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
  const exampleText = examples.length
    ? `\nExamples of owner corrections:\n${examples.map((e, i) => `${i + 1}. Input: ${e.original_caption}\nCorrect title: ${e.corrected_title}`).join('\n')}`
    : '';

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: `${rules}${exampleText}` }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: `Caption:\n${caption || '(no caption)'}\n\nFilename:\n${fileName || '(none)'}` }],
        },
      ],
      max_output_tokens: 120,
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`AI title generation failed: ${JSON.stringify(data)}`);
  const text = data.output_text?.trim();
  return text || fallbackTitle(caption, fileName);
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
