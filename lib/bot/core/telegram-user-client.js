import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { rawBot } from './telegram-client.js';
import { getTelegramAccount } from '../features/telegram-account.js';

const RESTRICTED_PATTERNS = [
  'CHAT_FORWARDS_RESTRICTED',
  'FORWARDS_RESTRICTED',
];

export async function getTelegramUserSessionConfig() {
  const saved = await getTelegramAccount().catch(() => null);
  if (saved?.api_id && saved?.api_hash && saved?.session) {
    return {
      apiId: Number(saved.api_id),
      apiHash: String(saved.api_hash),
      sessionString: String(saved.session),
      source: 'encrypted_store',
    };
  }

  const apiIdRaw = process.env.TELEGRAM_API_ID || process.env.API_ID || '';
  const apiHash = String(process.env.TELEGRAM_API_HASH || process.env.API_HASH || '').trim();
  const sessionString = String(process.env.TELEGRAM_SESSION_STRING || process.env.STRING || '').trim();
  const apiId = Number(apiIdRaw);

  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash || !sessionString) return null;
  return { apiId, apiHash, sessionString, source: 'environment' };
}

export async function telegramUserSessionConfigured() {
  return Boolean(await getTelegramUserSessionConfig());
}

/**
 * Copies a source Telegram post into this bot conversation using an authenticated
 * Telegram account. It uses Telegram's own server-side copy/forward RPC and does
 * not bypass chats that explicitly prohibit forwarding.
 */
export async function importTelegramPostViaUserSession({ parsed }) {
  const config = await getTelegramUserSessionConfig();
  if (!config) return { ok: false, code: 'not_configured' };

  const client = new TelegramClient(
    new StringSession(config.sessionString),
    config.apiId,
    config.apiHash,
    {
      connectionRetries: 3,
      retryDelay: 500,
      autoReconnect: false,
      sequentialUpdates: true,
    },
  );

  try {
    await client.connect();
    if (!(await client.checkAuthorization())) {
      return { ok: false, code: 'session_invalid' };
    }

    const source = await resolveSource(client, parsed);
    const sourceMessages = await loadSourceMessages(client, source, parsed.messageId);
    if (!sourceMessages.length) return { ok: false, code: 'message_not_found' };

    const primary = sourceMessages.find((item) => Number(item?.id) === Number(parsed.messageId))
      || sourceMessages[0];

    if (!hasTelegramMedia(primary)) {
      const text = String(primary?.message || '').trim();
      return text
        ? { ok: true, code: 'text', text }
        : { ok: false, code: 'empty_message' };
    }

    const botInfo = await rawBot('getMe', {});
    const botUsername = String(botInfo?.username || '').trim();
    if (!botUsername) return { ok: false, code: 'bot_username_missing' };

    const ids = sourceMessages
      .filter(hasTelegramMedia)
      .map((item) => Number(item.id))
      .filter(Number.isInteger)
      .sort((a, b) => a - b);

    try {
      const sent = await client.forwardMessages(`@${botUsername}`, {
        messages: ids,
        fromPeer: source,
        dropAuthor: true,
        silent: true,
      });

      const sentIds = (Array.isArray(sent) ? sent : [sent])
        .flat()
        .map((item) => Number(item?.id))
        .filter(Number.isInteger);

      return {
        ok: true,
        code: 'copied_to_bot',
        count: Math.max(ids.length, sentIds.length),
        sentIds,
      };
    } catch (error) {
      if (isForwardRestricted(error)) return { ok: false, code: 'forward_restricted' };
      throw error;
    }
  } catch (error) {
    return {
      ok: false,
      code: classifyMtprotoError(error),
      error: compactError(error),
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function resolveSource(client, parsed) {
  if (parsed?.kind === 'public' && parsed?.channel) return `@${parsed.channel}`;

  if (parsed?.kind === 'private' && parsed?.sourceChatId) {
    await client.getDialogs({ limit: 500 });
    return parsed.sourceChatId;
  }

  throw new Error('Unsupported Telegram source link');
}

async function loadSourceMessages(client, source, messageId) {
  const firstList = await client.getMessages(source, { ids: Number(messageId) });
  const first = Array.isArray(firstList) ? firstList[0] : firstList;
  if (!first || !Number(first.id)) return [];

  const groupedId = normalizeId(first.groupedId);
  if (!groupedId || groupedId === '0') return [first];

  const ids = [];
  for (let id = Math.max(1, Number(messageId) - 9); id <= Number(messageId) + 9; id += 1) ids.push(id);

  const nearby = await client.getMessages(source, { ids });
  return (Array.isArray(nearby) ? nearby : [nearby])
    .filter(Boolean)
    .filter((item) => normalizeId(item.groupedId) === groupedId)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function hasTelegramMedia(message) {
  return Boolean(message?.media);
}

function normalizeId(value) {
  if (value == null) return '';
  if (typeof value === 'object' && typeof value.toString === 'function') {
    return String(value.toString()).replace(/^\+/, '').trim();
  }
  return String(value).replace(/^\+/, '').trim();
}

function isForwardRestricted(error) {
  const text = String(error?.errorMessage || error?.message || error || '').toUpperCase();
  return RESTRICTED_PATTERNS.some((needle) => text.includes(needle));
}

function classifyMtprotoError(error) {
  const text = String(error?.errorMessage || error?.message || error || '').toUpperCase();
  if (text.includes('CHANNEL_PRIVATE')) return 'source_not_accessible';
  if (text.includes('USERNAME_NOT_OCCUPIED') || text.includes('USERNAME_INVALID')) return 'source_not_found';
  if (text.includes('MSG_ID_INVALID') || text.includes('MESSAGE_IDS_EMPTY')) return 'message_not_found';
  if (text.includes('AUTH_KEY') || text.includes('SESSION_REVOKED') || text.includes('USER_DEACTIVATED')) return 'session_invalid';
  if (isForwardRestricted(error)) return 'forward_restricted';
  return 'mtproto_error';
}

function compactError(error) {
  return String(error?.errorMessage || error?.message || error || 'unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}
