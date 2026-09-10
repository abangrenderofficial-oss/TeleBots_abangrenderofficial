import { escapeHtml } from './caption.js';

export function telegramTextToHtml(text = '', entities = []) {
  const source = String(text || '');
  if (!entities?.length) return escapeHtml(source);

  const opens = new Map();
  const closes = new Map();

  for (const e of entities) {
    const start = Number(e.offset || 0);
    const end = start + Number(e.length || 0);
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
  let i = 0;
  while (i <= source.length) {
    if (closes.has(i)) out += closes.get(i);
    if (opens.has(i)) out += opens.get(i);
    if (i === source.length) break;

    const cp = source.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    out += escapeHtml(ch);
    i += ch.length;
  }
  return out;
}

export function telegramSubstringToHtml(text = '', entities = [], substring = '') {
  const source = String(text || '');
  const wanted = String(substring || '').trim();
  if (!wanted) return '';

  const start = source.indexOf(wanted);
  if (start < 0) return escapeHtml(wanted);
  const end = start + wanted.length;

  const clipped = (entities || [])
    .map((e) => {
      const eStart = Number(e.offset || 0);
      const eEnd = eStart + Number(e.length || 0);
      const clipStart = Math.max(eStart, start);
      const clipEnd = Math.min(eEnd, end);
      if (clipEnd <= clipStart) return null;
      return {
        ...e,
        offset: clipStart - start,
        length: clipEnd - clipStart,
      };
    })
    .filter(Boolean);

  return telegramTextToHtml(source.slice(start, end), clipped);
}
