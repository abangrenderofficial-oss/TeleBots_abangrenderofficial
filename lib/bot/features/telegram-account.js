import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { getSetting, setSetting } from '../../store.js';
import { rawBot } from '../core/telegram-client.js';

const ACCOUNT_KEY = 'telegram_mtproto_account_v1';
const LOGIN_KEY = 'telegram_mtproto_login_v1';
const STATE_PREFIX = 'TG_CONNECT_';

function keyMaterial() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return createHash('sha256').update('telegram-mtproto:v1:').update(token).digest();
}

function encryptJson(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyMaterial(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptJson(value) {
  if (!value || typeof value !== 'string') return null;
  const [version, ivRaw, tagRaw, payloadRaw] = value.split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !payloadRaw) return null;
  const decipher = createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payloadRaw, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

export async function getTelegramAccount() {
  const encrypted = await getSetting(ACCOUNT_KEY).catch(() => null);
  if (!encrypted) return null;
  try {
    return decryptJson(encrypted);
  } catch {
    return null;
  }
}

async function saveTelegramAccount(account) {
  await setSetting(ACCOUNT_KEY, encryptJson(account));
}

async function getPendingLogin() {
  const encrypted = await getSetting(LOGIN_KEY).catch(() => null);
  if (!encrypted) return null;
  try {
    return decryptJson(encrypted);
  } catch {
    return null;
  }
}

async function savePendingLogin(data) {
  await setSetting(LOGIN_KEY, encryptJson(data));
}

async function clearPendingLogin() {
  await setSetting(LOGIN_KEY, null);
}

export function isTelegramConnectState(state) {
  return Boolean(state?.mode && String(state.mode).startsWith(STATE_PREFIX));
}

export async function beginTelegramAccountConnect(chatId) {
  const existing = await getTelegramAccount();
  if (existing?.session) {
    const label = existing.username ? `@${existing.username}` : (existing.user_id ? `ID ${existing.user_id}` : 'akaun Telegram');
    await rawBot('sendMessage', {
      chat_id: chatId,
      text: `✅ ${label} dah connected untuk Telegram Link Import.\n\nKalau nak tukar akaun, guna /tglogout dulu kemudian /tglogin semula.`,
    });
    return { connected: true };
  }

  await clearPendingLogin();
  await setSetting('admin_state', { mode: 'TG_CONNECT_API', started_at: new Date().toISOString() });
  await rawBot('sendMessage', {
    chat_id: chatId,
    text: [
      '🔐 Telegram Account Connect — Step 1/2',
      '',
      'Hantar API ID dan API HASH dalam satu mesej:',
      '<API_ID> <API_HASH>',
      '',
      'Ambil dari my.telegram.org → API development tools.',
      'Mesej credential yang kau hantar akan dipadam terus selepas dibaca.',
      '',
      'Lepas ni bot guna Telegram QR/deep-link authorization rasmi — tak perlu OTP.',
      '',
      'Batal bila-bila masa: /tgcancel',
    ].join('\n'),
    disable_web_page_preview: true,
  });
  return { connected: false };
}

export async function cancelTelegramAccountConnect(chatId) {
  await clearPendingLogin();
  const state = await getSetting('admin_state').catch(() => null);
  if (isTelegramConnectState(state)) await setSetting('admin_state', null);
  await rawBot('sendMessage', { chat_id: chatId, text: 'Telegram Account Connect dibatalkan.' });
}

export async function disconnectTelegramAccount(chatId) {
  const account = await getTelegramAccount();
  if (account?.session && account?.api_id && account?.api_hash) {
    let client;
    try {
      client = createClient(account);
      await client.connect();
      await client.invoke(new Api.auth.LogOut({}));
    } catch {
      // Local credential removal is authoritative even if Telegram logout fails.
    } finally {
      await client?.disconnect().catch(() => {});
    }
  }

  await setSetting(ACCOUNT_KEY, null);
  await clearPendingLogin();
  const state = await getSetting('admin_state').catch(() => null);
  if (isTelegramConnectState(state)) await setSetting('admin_state', null);
  await rawBot('sendMessage', { chat_id: chatId, text: '✅ Telegram user-session dah dibuang dari bot.' });
}

export async function handleTelegramConnectInput({ message, state }) {
  if (!isTelegramConnectState(state)) return false;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();
  if (!chatId || !text) return false;

  await deleteSensitiveInput(message);

  if (state.mode === 'TG_CONNECT_API') {
    const match = text.match(/^(\d{4,12})\s+([a-fA-F0-9]{24,64})$/);
    if (!match) {
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: 'Format tak betul. Hantar macam ni: <API_ID> <API_HASH>\nContoh: 123456 abcdef1234567890abcdef1234567890',
      });
      return true;
    }

    const pending = {
      api_id: Number(match[1]),
      api_hash: match[2],
      chat_id: chatId,
      created_at: new Date().toISOString(),
    };
    await savePendingLogin(pending);
    await setSetting('admin_state', { mode: 'TG_CONNECT_QR' });

    try {
      const result = await exportOrFinishQrLogin(pending);
      if (!result.connected) await sendQrApproveMessage(chatId, result.deep_link);
    } catch (error) {
      await clearPendingLogin();
      await setSetting('admin_state', null);
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: `❌ Tak berjaya mulakan Telegram authorization: ${friendlyError(error)}\nJalankan /tglogin semula.`,
      });
    }
    return true;
  }

  if (state.mode === 'TG_CONNECT_QR') {
    if (text.toLowerCase() !== 'check') {
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: 'Tekan button 🔐 Approve Telegram Login yang bot bagi tadi. Lepas approve, taip: check',
      });
      return true;
    }

    const pending = await getPendingLogin();
    if (!pending?.api_id || !pending?.api_hash || !pending?.chat_id) {
      await setSetting('admin_state', null);
      await rawBot('sendMessage', { chat_id: chatId, text: 'Secure login state dah tamat. Jalankan /tglogin semula.' });
      return true;
    }

    try {
      const result = await exportOrFinishQrLogin(pending);
      if (!result.connected) {
        await rawBot('sendMessage', {
          chat_id: chatId,
          text: 'Belum detect approval / token lama dah bertukar. Tekan button baru bawah ni, approve, kemudian taip check lagi.',
          reply_markup: {
            inline_keyboard: [[{ text: '🔐 Approve Telegram Login', url: result.deep_link }]],
          },
        });
      }
    } catch (error) {
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: `❌ Check login gagal: ${friendlyError(error)}\nKalau token dah tamat, /tgcancel kemudian /tglogin semula.`,
      });
    }
    return true;
  }

  // Compatibility guard for stale states from the old OTP-in-chat flow.
  if (['TG_CONNECT_PHONE', 'TG_CONNECT_CODE', 'TG_CONNECT_PASSWORD', 'TG_CONNECT_WEB_CODE', 'TG_CONNECT_WEB_PASSWORD'].includes(state.mode)) {
    await clearPendingLogin();
    await setSetting('admin_state', null);
    await rawBot('sendMessage', {
      chat_id: chatId,
      text: 'Flow login lama dah dihentikan sebab Telegram invalidate OTP yang dihantar dalam chat. Jalankan /tglogin semula untuk QR/deep-link authorization.',
    });
    return true;
  }

  return false;
}

async function sendQrApproveMessage(chatId, deepLink) {
  await rawBot('sendMessage', {
    chat_id: chatId,
    text: [
      '📲 Step 2/2 — Telegram Authorization',
      '',
      '1. Tekan button bawah dan approve login dalam Telegram.',
      '2. Kembali ke bot ini dan taip: check',
      '',
      'Tak perlu hantar OTP atau password ke bot.',
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[{ text: '🔐 Approve Telegram Login', url: deepLink }]],
    },
  });
}

async function exportOrFinishQrLogin(pending) {
  let client;
  try {
    client = createClient({ ...pending, session: pending.temp_session || '' });
    await client.connect();

    if (await client.checkAuthorization()) {
      await finishTelegramLogin({ chatId: pending.chat_id, pending, client });
      return { connected: true };
    }

    let result = await client.invoke(new Api.auth.ExportLoginToken({
      apiId: Number(pending.api_id),
      apiHash: String(pending.api_hash),
      exceptIds: [],
    }));

    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      if (typeof client._switchDC !== 'function') throw new Error('Telegram DC migration tak disokong oleh client');
      await client._switchDC(result.dcId);
      result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
    }

    if (result instanceof Api.auth.LoginTokenSuccess) {
      await finishTelegramLogin({ chatId: pending.chat_id, pending, client });
      return { connected: true };
    }

    if (!(result instanceof Api.auth.LoginToken)) {
      throw new Error('Telegram pulangkan QR login response yang tak dikenali');
    }

    const updated = {
      ...pending,
      temp_session: client.session.save(),
      qr_generated_at: new Date().toISOString(),
      qr_expires: Number(result.expires || 0),
    };
    await savePendingLogin(updated);

    return {
      connected: false,
      deep_link: `tg://login?token=${result.token.toString('base64url')}`,
      expires: updated.qr_expires,
    };
  } finally {
    await client?.disconnect().catch(() => {});
  }
}

async function finishTelegramLogin({ chatId, pending, client }) {
  const me = await client.getMe();
  const session = client.session.save();
  if (!session) throw new Error('Telegram session string kosong selepas login');

  const actualUserId = me?.id ? String(me.id) : '';
  const expectedAdminId = String(process.env.ADMIN_TELEGRAM_ID || '').trim();
  if (expectedAdminId && actualUserId !== expectedAdminId) {
    await client.invoke(new Api.auth.LogOut({})).catch(() => {});
    await clearPendingLogin();
    await setSetting('admin_state', null);
    throw new Error('Akaun Telegram yang di-approve bukan akaun admin bot ini');
  }

  await saveTelegramAccount({
    api_id: pending.api_id,
    api_hash: pending.api_hash,
    session,
    user_id: actualUserId || null,
    username: me?.username || null,
    connected_at: new Date().toISOString(),
  });
  await clearPendingLogin();
  await setSetting('admin_state', null);

  const label = me?.username ? `@${me.username}` : (me?.firstName || 'Telegram account');
  await rawBot('sendMessage', {
    chat_id: chatId,
    text: `✅ ${label} connected.\n\nSekarang paste link Telegram macam https://t.me/free3dsky/29983. Bot akan cuba copy biasa dulu dan auto guna user-session bila perlu.`,
    disable_web_page_preview: true,
  });
}

export function createClient(account) {
  return new TelegramClient(
    new StringSession(account?.session || ''),
    Number(account?.api_id),
    String(account?.api_hash || ''),
    { connectionRetries: 3, autoReconnect: false, floodSleepThreshold: 15 },
  );
}

async function deleteSensitiveInput(message) {
  if (!message?.chat?.id || !message?.message_id) return;
  await rawBot('deleteMessage', { chat_id: message.chat.id, message_id: message.message_id }).catch(() => {});
}

export function friendlyError(error) {
  const raw = String(error?.errorMessage || error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 180);
  if (/PHONE_CODE_INVALID/i.test(raw)) return 'login code tak betul';
  if (/PHONE_CODE_EXPIRED/i.test(raw)) return 'login code dah tidak sah / telah di-invalidate Telegram';
  if (/PASSWORD_HASH_INVALID|PASSWORD/i.test(raw) && /INVALID/i.test(raw)) return 'password 2FA tak betul';
  if (/API_ID_INVALID/i.test(raw)) return 'API ID/API HASH tak valid';
  if (/PHONE_NUMBER_INVALID/i.test(raw)) return 'nombor telefon tak valid';
  if (/AUTH_TOKEN_EXPIRED/i.test(raw)) return 'Telegram login token dah expired';
  if (/AUTH_TOKEN/i.test(raw) && /INVALID/i.test(raw)) return 'Telegram login token tak valid';
  if (/FLOOD_WAIT/i.test(raw)) return `Telegram rate-limit: ${raw}`;
  return raw;
}
