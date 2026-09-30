import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
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
      '🔐 Telegram Account Connect — Step 1/4',
      '',
      'Hantar API ID dan API HASH dalam satu mesej:',
      '<API_ID> <API_HASH>',
      '',
      'Ambil dari my.telegram.org → API development tools.',
      'Mesej credential yang kau hantar akan dipadam terus selepas dibaca.',
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

    await savePendingLogin({ api_id: Number(match[1]), api_hash: match[2], created_at: new Date().toISOString() });
    await setSetting('admin_state', { mode: 'TG_CONNECT_PHONE' });
    await rawBot('sendMessage', {
      chat_id: chatId,
      text: '📱 Step 2/4 — Hantar nombor Telegram termasuk country code.\nContoh: +60123456789',
    });
    return true;
  }

  const pending = await getPendingLogin();
  if (!pending?.api_id || !pending?.api_hash) {
    await setSetting('admin_state', null);
    await rawBot('sendMessage', { chat_id: chatId, text: 'Session setup dah tamat. Jalankan /tglogin semula.' });
    return true;
  }

  if (state.mode === 'TG_CONNECT_PHONE') {
    const phone = text.replace(/[\s()-]/g, '');
    if (!/^\+\d{8,15}$/.test(phone)) {
      await rawBot('sendMessage', { chat_id: chatId, text: 'Nombor tak valid. Guna format penuh macam +60123456789.' });
      return true;
    }

    let client;
    try {
      client = createClient({ ...pending, session: '' });
      await client.connect();
      const sent = await client.sendCode({ apiId: pending.api_id, apiHash: pending.api_hash }, phone);
      await savePendingLogin({
        ...pending,
        phone,
        phone_code_hash: sent.phoneCodeHash,
        temp_session: client.session.save(),
      });
      await setSetting('admin_state', { mode: 'TG_CONNECT_CODE' });
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: '🔢 Step 3/4 — Telegram dah hantar login code. Hantar code tu di sini. Ruang antara nombor tak apa; mesej code akan dipadam terus.',
      });
    } catch (error) {
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: `❌ Tak berjaya hantar login code: ${friendlyError(error)}\nSemak API ID/API HASH atau nombor tadi.`,
      });
    } finally {
      await client?.disconnect().catch(() => {});
    }
    return true;
  }

  if (state.mode === 'TG_CONNECT_CODE') {
    const code = text.replace(/\s+/g, '');
    if (!/^\d{4,8}$/.test(code)) {
      await rawBot('sendMessage', { chat_id: chatId, text: 'Code tak valid. Hantar nombor code Telegram sahaja.' });
      return true;
    }

    if (!pending.phone || !pending.phone_code_hash || !pending.temp_session) {
      await setSetting('admin_state', null);
      await clearPendingLogin();
      await rawBot('sendMessage', { chat_id: chatId, text: 'Login state tak lengkap. Jalankan /tglogin semula.' });
      return true;
    }

    let client;
    try {
      client = createClient({ ...pending, session: pending.temp_session });
      await client.connect();
      await client.invoke(new Api.auth.SignIn({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phone_code_hash,
        phoneCode: code,
      }));
      await finishTelegramLogin({ chatId, pending, client });
    } catch (error) {
      if (telegramErrorCode(error).includes('SESSION_PASSWORD_NEEDED')) {
        await savePendingLogin({ ...pending, temp_session: client?.session?.save?.() || pending.temp_session });
        await setSetting('admin_state', { mode: 'TG_CONNECT_PASSWORD' });
        await rawBot('sendMessage', {
          chat_id: chatId,
          text: '🔐 Step 4/4 — Akaun ni ada Telegram 2-Step Verification. Hantar password 2FA. Mesej password akan dipadam terus.',
        });
      } else {
        await rawBot('sendMessage', {
          chat_id: chatId,
          text: `❌ Login code gagal: ${friendlyError(error)}\nCuba code semula, atau /tgcancel kemudian /tglogin untuk restart.`,
        });
      }
    } finally {
      await client?.disconnect().catch(() => {});
    }
    return true;
  }

  if (state.mode === 'TG_CONNECT_PASSWORD') {
    if (!pending.temp_session) {
      await setSetting('admin_state', null);
      await clearPendingLogin();
      await rawBot('sendMessage', { chat_id: chatId, text: 'Login state tak lengkap. Jalankan /tglogin semula.' });
      return true;
    }

    let client;
    try {
      client = createClient({ ...pending, session: pending.temp_session });
      await client.connect();
      await client.signInWithPassword(
        { apiId: pending.api_id, apiHash: pending.api_hash },
        {
          password: async () => text,
          onError: async (error) => { throw error; },
        },
      );
      await finishTelegramLogin({ chatId, pending, client });
    } catch (error) {
      await rawBot('sendMessage', {
        chat_id: chatId,
        text: `❌ Password 2FA gagal: ${friendlyError(error)}\nCuba semula atau /tgcancel.`,
      });
    } finally {
      await client?.disconnect().catch(() => {});
    }
    return true;
  }

  return false;
}

async function finishTelegramLogin({ chatId, pending, client }) {
  const me = await client.getMe();
  const session = client.session.save();
  if (!session) throw new Error('Telegram session string kosong selepas login');

  await saveTelegramAccount({
    api_id: pending.api_id,
    api_hash: pending.api_hash,
    session,
    user_id: me?.id ? String(me.id) : null,
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

function telegramErrorCode(error) {
  return String(error?.errorMessage || error?.code || error?.message || error || '').trim().toUpperCase();
}

export function friendlyError(error) {
  const raw = String(error?.errorMessage || error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 180);
  if (/PHONE_CODE_INVALID/i.test(raw)) return 'login code tak betul';
  if (/PHONE_CODE_EXPIRED/i.test(raw)) return 'login code dah expired';
  if (/PASSWORD_HASH_INVALID|PASSWORD/i.test(raw) && /INVALID/i.test(raw)) return 'password 2FA tak betul';
  if (/API_ID_INVALID/i.test(raw)) return 'API ID/API HASH tak valid';
  if (/PHONE_NUMBER_INVALID/i.test(raw)) return 'nombor telefon tak valid';
  if (/FLOOD_WAIT/i.test(raw)) return `Telegram rate-limit: ${raw}`;
  return raw;
}
