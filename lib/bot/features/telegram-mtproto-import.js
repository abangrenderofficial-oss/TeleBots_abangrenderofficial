import { existsSync, openAsBlob } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { getTelegramAccount, createClient, friendlyError } from './telegram-account.js';
import { rawBot } from '../core/telegram-client.js';

const MAX_CAPTION = 1024;

export async function importTelegramPostViaMtproto({ parsed, chatId }) {
  const account = await getTelegramAccount();
  if (!account?.session) return { ok: false, reason: 'not_connected' };

  let client;
  let workdir;
  try {
    client = createClient(account);
    await client.connect();
    if (!(await client.checkAuthorization())) {
      return { ok: false, reason: 'session_expired' };
    }

    const entity = await resolveSourceEntity(client, parsed);
    const messages = await client.getMessages(entity, { ids: parsed.messageId });
    const message = Array.isArray(messages) ? messages[0] : messages?.[0];
    if (!message || message.className === 'MessageEmpty') {
      return { ok: false, reason: 'message_not_found' };
    }

    const text = String(message.message || '').trim();
    if (!message.media) {
      if (!text) return { ok: false, reason: 'unsupported_message' };
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: text.slice(0, 4096),
        disable_web_page_preview: false,
      });
      return { ok: true, kind: 'text' };
    }

    workdir = await mkdtemp(join(tmpdir(), 'tg-import-'));
    const meta = mediaMeta(message, parsed);
    const target = join(workdir, meta.fileName);
    const downloaded = await client.downloadMedia(message, { outputFile: target });
    const filePath = typeof downloaded === 'string' && existsSync(downloaded)
      ? downloaded
      : target;
    if (!existsSync(filePath)) throw new Error('MTProto download returned no file');

    await sendDownloadedFile({
      chatId,
      filePath,
      fileName: basename(filePath) || meta.fileName,
      mimeType: meta.mimeType,
      kind: meta.kind,
      caption: text,
    });
    return { ok: true, kind: meta.kind };
  } catch (error) {
    return { ok: false, reason: 'mtproto_error', error: friendlyError(error) };
  } finally {
    await client?.disconnect().catch(() => {});
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveSourceEntity(client, parsed) {
  if (parsed.kind === 'public') return parsed.channel;
  const peerId = BigInt(parsed.sourceChatId);
  try {
    await client.getInputEntity(peerId);
    return peerId;
  } catch {
    // StringSession intentionally stores auth keys, not the whole entity cache.
    // Load dialogs once so private channel access_hash values become available.
    await client.getDialogs({ limit: 300 });
    await client.getInputEntity(peerId);
    return peerId;
  }
}

function mediaMeta(message, parsed) {
  const media = message.media;
  const document = media?.document || message.document || null;
  const mimeType = String(document?.mimeType || 'application/octet-stream');
  const attrs = Array.isArray(document?.attributes) ? document.attributes : [];
  const filenameAttr = attrs.find((attr) => attr?.className === 'DocumentAttributeFilename');
  const audioAttr = attrs.find((attr) => attr?.className === 'DocumentAttributeAudio');
  const videoAttr = attrs.find((attr) => attr?.className === 'DocumentAttributeVideo');
  const stickerAttr = attrs.find((attr) => attr?.className === 'DocumentAttributeSticker');
  const animatedAttr = attrs.find((attr) => attr?.className === 'DocumentAttributeAnimated');

  let kind = 'document';
  if (media?.photo || message.photo) kind = 'photo';
  else if (stickerAttr) kind = 'sticker';
  else if (audioAttr?.voice) kind = 'voice';
  else if (audioAttr) kind = 'audio';
  else if (animatedAttr) kind = 'animation';
  else if (videoAttr?.roundMessage) kind = 'video_note';
  else if (videoAttr || mimeType.startsWith('video/')) kind = 'video';

  const base = `telegram_${parsed.channel || 'private'}_${parsed.messageId}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const defaultExt = extensionFor(kind, mimeType);
  const fileName = sanitizeFilename(filenameAttr?.fileName || `${base}${defaultExt}`);
  return { kind, mimeType, fileName };
}

function extensionFor(kind, mimeType) {
  if (kind === 'photo') return '.jpg';
  if (kind === 'sticker') return mimeType.includes('webm') ? '.webm' : (mimeType.includes('tgsticker') ? '.tgs' : '.webp');
  if (kind === 'voice') return '.ogg';
  if (kind === 'audio') return mimeType.includes('mpeg') ? '.mp3' : '.m4a';
  if (kind === 'animation') return mimeType.includes('gif') ? '.gif' : '.mp4';
  if (kind === 'video' || kind === 'video_note') return '.mp4';
  if (mimeType.includes('zip')) return '.zip';
  if (mimeType.includes('pdf')) return '.pdf';
  return '';
}

function sanitizeFilename(name) {
  const raw = String(name || 'telegram_file').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').slice(-180);
  return raw || 'telegram_file';
}

async function sendDownloadedFile({ chatId, filePath, fileName, mimeType, kind, caption }) {
  const methodMap = {
    photo: ['sendPhoto', 'photo'],
    video: ['sendVideo', 'video'],
    animation: ['sendAnimation', 'animation'],
    audio: ['sendAudio', 'audio'],
    voice: ['sendVoice', 'voice'],
    video_note: ['sendVideoNote', 'video_note'],
    sticker: ['sendSticker', 'sticker'],
    document: ['sendDocument', 'document'],
  };
  const [method, fileField] = methodMap[kind] || methodMap.document;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  const form = new FormData();
  form.set('chat_id', String(chatId));
  const blob = await openAsBlob(filePath, { type: mimeType || 'application/octet-stream' });
  form.set(fileField, blob, fileName || basename(filePath));
  if (caption && kind !== 'video_note' && kind !== 'sticker') form.set('caption', caption.slice(0, MAX_CAPTION));
  if (kind === 'video') form.set('supports_streaming', 'true');

  let response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    body: form,
  });
  let data = await response.json().catch(() => ({}));
  if (response.ok && data.ok) return data.result;

  // Telegram can reject a media-specific method for unusual codecs. Retry as
  // a generic document so the bytes still reach the user unchanged.
  if (kind !== 'document') {
    const fallback = new FormData();
    fallback.set('chat_id', String(chatId));
    const fallbackBlob = await openAsBlob(filePath, { type: mimeType || 'application/octet-stream' });
    fallback.set('document', fallbackBlob, fileName || basename(filePath));
    if (caption) fallback.set('caption', caption.slice(0, MAX_CAPTION));
    response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: fallback,
    });
    data = await response.json().catch(() => ({}));
    if (response.ok && data.ok) return data.result;
  }

  throw new Error(data.description || `Telegram upload failed (${response.status})`);
}

export function inferExtensionFromFilename(fileName, fallback = '') {
  return extname(String(fileName || '')) || fallback;
}
