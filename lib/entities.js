import { escapeHtml } from './caption.js';

export function telegramTextToHtml(text = '', entities = []) {
  if (!entities?.length) return escapeHtml(text);

  const chars = Array.from(text);
  const opens = new Map();
  const closes = new Map();

  for (const e of entities) {
    const start = e.offset;
    const end = e.offset + e.length;
    let open = '';
    let close = '';

    if (e.type === 'text_link' && e.url) {
      open = `<a href="${escapeHtml(e.url)}">`;
      close = '</a>';
    } else if (e.type === 'bold') {
      open = '<b>'; close = '</b>';
    } else if (e.type === 'italic') {
      open = '<i>'; close = '</i>';
    } else if (e.type === 'underline') {
      open = '<u>'; close = '</u>';
    } else if (e.type === 'strikethrough') {
      open = '<s>'; close = '</s>';
    } else if (e.type === 'code') {
      open = '<code>'; close = '</code>';
    } else {
      continue;
    }

    opens.set(start, (opens.get(start) || '') + open);
    closes.set(end, close + (closes.get(end) || ''));
  }

  let out = '';
  for (let i = 0; i <= chars.length; i++) {
    if (closes.has(i)) out += closes.get(i);
    if (opens.has(i)) out += opens.get(i);
    if (i < chars.length) out += escapeHtml(chars[i]);
  }
  return out;
}
