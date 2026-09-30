import { rawBot } from '../core/telegram-client.js';
import {
  importTelegramPostViaUserSession,
  telegramUserSessionConfigured,
} from '../core/telegram-user-client.js';

const PUBLIC_POST_RE = /https?:\/\/(?:t|telegram)\.me\/(?:s\/)?([A-Za-z0-9_]{4,})\/(?:\d+\/)?(\d+)(?:[?#][^\s]*)?/i;
const PRIVATE_POST_RE = /https?:\/\/(?:t|telegram)\.me\/c\/(\d+)\/(?:\d+\/)?(\d+)(?:[?#][^\s]*)?/i;
const MAX_CAPTION = 1024;
const MAX_TEXT = 4096;

export function extractTelegramPostLink(text) {
  const input = String(text || '');
  const privateMatch = input.match(PRIVATE_POST_RE);
  if (privateMatch) {
    return {
      url: privateMatch[0],
      kind: 'private',
      sourceChatId: `-100${privateMatch[1]}`,
      messageId: Number(privateMatch[2]),
      channel: null,
    };
  }

  const publicMatch = input.match(PUBLIC_POST_RE);
  if (publicMatch) {
    const channel = publicMatch[1];
    return {
      url: publicMatch[0],
      kind: 'public',
      sourceChatId: `@${channel}`,
      messageId: Number(publicMatch[2]),
      channel,
    };
  }

  return null;
}

export async function handleTelegramPostLink({ message }) {
  const parsed = extractTelegramPostLink(message?.text || message?.caption || '');
  if (!parsed) return false;

  const chatId = message?.chat?.id;
  if (!chatId) return false;

  let copyError = null;
  try {
    await rawBot('copyMessage', {
      chat_id: chatId,
      from_chat_id: parsed.sourceChatId,
      message_id: parsed.messageId,
    });
    return true;
  } catch (error) {
    copyError = error;
  }

  let mtprotoResult = null;
  if (telegramUserSessionConfigured()) {
    await rawBot('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
    }).catch(() => {});

    mtprotoResult = await importTelegramPostViaUserSession({
      parsed,
      adminUserId: message?.from?.id,
    });

    if (mtprotoResult?.ok && mtprotoResult.code === 'text') {
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: String(mtprotoResult.text || '').slice(0, MAX_TEXT),
        disable_web_page_preview: false,
      });
      return true;
    }

    if (mtprotoResult?.ok && mtprotoResult.code === 'copied_to_bot') {
      // The owner-session copied the media into this exact bot conversation.
      // Telegram will deliver that copied media back through the normal webhook,
      // where the existing upload/recaption pipeline can process it naturally.
      return true;
    }

    if (mtprotoResult?.code === 'forward_restricted') {
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: '❌ Telegram tak benarkan post ini dicopy/forward dari source tersebut.',
      }).catch(() => {});
      return true;
    }

    if (mtprotoResult?.code === 'wrong_account') {
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: '❌ Telegram session yang disambungkan bukan akaun owner bot ini. Tukar session kepada akaun Telegram yang sama.',
      }).catch(() => {});
      return true;
    }

    if (mtprotoResult?.code === 'session_invalid') {
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: '❌ Telegram user session dah tak valid. Login semula dan update session string.',
      }).catch(() => {});
      return true;
    }
  }

  if (parsed.kind === 'public') {
    try {
      const preview = await fetchPublicTelegramPreview(parsed);
      const sent = await sendPreviewBackToChat({ chatId, preview });
      if (sent) return true;
    } catch {
      // Public widgets intentionally hide some post/media types. MTProto is the
      // authenticated fallback for those cases.
    }
  }

  const reason = mtprotoResult?.error || compactError(copyError);
  const setupHint = telegramUserSessionConfigured()
    ? ''
    : '\n\n🔐 Post jenis ini perlukan Telegram user session (API_ID + API_HASH + STRING).';

  await rawBot('sendMessage', {
    chat_id: chatId,
    text: `❌ Tak dapat ambil post Telegram ini.${setupHint}${reason ? `\n\n${reason}` : ''}`.slice(0, MAX_TEXT),
  }).catch(() => {});
  return true;
}

export async function fetchPublicTelegramPreview(parsedOrUrl) {
  const parsed = typeof parsedOrUrl === 'string'
    ? extractTelegramPostLink(parsedOrUrl)
    : parsedOrUrl;

  if (!parsed || parsed.kind !== 'public' || !parsed.channel) {
    throw new Error('Public Telegram post link required');
  }

  const embedUrl = `https://t.me/${encodeURIComponent(parsed.channel)}/${parsed.messageId}?embed=1&single=1&mode=tme`;
  const response = await fetch(embedUrl, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; AbangRenderTelegramImporter/1.0)',
      accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`Telegram preview HTTP ${response.status}`);
  }

  const html = await response.text();
  if (!html || !/tgme_widget_message/i.test(html)) {
    throw new Error('Telegram preview message markup not found');
  }

  return parseTelegramPreviewHtml(html, parsed);
}

export function parseTelegramPreviewHtml(html, parsed = null) {
  const source = String(html || '');
  const text = extractMessageText(source);
  const media = [];

  for (const match of source.matchAll(/<video\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    pushUnique(media, { type: 'video', url: decodeHtml(match[1]) });
  }

  for (const match of source.matchAll(/<audio\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    pushUnique(media, { type: 'audio', url: decodeHtml(match[1]) });
  }

  for (const block of source.matchAll(/<a\b[^>]*tgme_widget_message_photo_wrap[^>]*>/gi)) {
    const urlMatch = block[0].match(/background-image\s*:\s*url\((?:&quot;|['"])?(https?:\/\/[^)'"\s&]+)(?:&quot;|['"])?\)/i);
    if (urlMatch) pushUnique(media, { type: 'photo', url: decodeHtml(urlMatch[1]) });
  }

  const documentTitle = decodeHtml(firstMatch(source, /class=["'][^"']*tgme_widget_message_document_title[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i));
  const documentExtra = decodeHtml(firstMatch(source, /class=["'][^"']*tgme_widget_message_document_extra[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i));
  const unsupported = /message_media_not_supported_wrap|text_not_supported_wrap/i.test(source);

  return {
    channel: parsed?.channel || null,
    messageId: parsed?.messageId || null,
    text,
    media,
    unsupported,
    document: documentTitle || documentExtra
      ? { title: stripTags(documentTitle), extra: stripTags(documentExtra) }
      : null,
    htmlLength: source.length,
  };
}

async function sendPreviewBackToChat({ chatId, preview }) {
  if (preview?.unsupported) return false;

  const caption = String(preview?.text || '').slice(0, MAX_CAPTION);
  const media = Array.isArray(preview?.media) ? preview.media : [];

  if (media.length > 1 && media.every((item) => item.type === 'photo' || item.type === 'video')) {
    const group = media.slice(0, 10).map((item, index) => ({
      type: item.type,
      media: item.url,
      ...(index === 0 && caption ? { caption } : {}),
    }));
    await rawBot('sendMediaGroup', { chat_id: chatId, media: group });
    return true;
  }

  const first = media[0];
  if (first?.type === 'video') {
    await rawBot('sendVideo', { chat_id: chatId, video: first.url, ...(caption ? { caption } : {}) });
    return true;
  }
  if (first?.type === 'photo') {
    await rawBot('sendPhoto', { chat_id: chatId, photo: first.url, ...(caption ? { caption } : {}) });
    return true;
  }
  if (first?.type === 'audio') {
    await rawBot('sendAudio', { chat_id: chatId, audio: first.url, ...(caption ? { caption } : {}) });
    return true;
  }

  if (preview?.text) {
    await rawBot('sendMessage', { chat_id: chatId, text: String(preview.text).slice(0, MAX_TEXT) });
    return true;
  }

  return false;
}

function extractMessageText(html) {
  const raw = firstMatch(html, /<div\b[^>]*class=["'][^"']*tgme_widget_message_text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  return stripTags(
    decodeHtml(
      String(raw || '')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/p>\s*<p[^>]*>/gi, '\n'),
    ),
  ).trim();
}

function firstMatch(input, regex) {
  return String(input || '').match(regex)?.[1] || '';
}

function stripTags(input) {
  return String(input || '').replace(/<[^>]*>/g, '').replace(/\u00a0/g, ' ').trim();
}

function decodeHtml(input) {
  return String(input || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/');
}

function pushUnique(list, item) {
  if (!item?.url || !/^https?:\/\//i.test(item.url)) return;
  if (list.some((existing) => existing.type === item.type && existing.url === item.url)) return;
  list.push(item);
}

function compactError(error) {
  return String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 160);
}
