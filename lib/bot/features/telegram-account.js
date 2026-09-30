import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function publicBaseUrl() {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.APP_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  const host = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  if (host) return `${host.startsWith('http') ? '' : 'https://'}${host}`.replace(/\/$/, '');
  return 'https://tele-bots-abangrenderofficial.vercel.app';
}

function qrPageUrl(viewKey) {
  return `${publicBaseUrl()}/api/telegram-qr?key=${encodeURIComponent(viewKey)}`;
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

export async function runTelegramQrAuthorization(viewKey, { onQr, abortSignal } = {}) {
  const pending = await getPendingLogin();
  if (!pending?.qr_view_key || !secureEqual(viewKey, pending.qr_view_key)) {
    return { valid: false, connected: false };
  }

  let client;
  try {
    client = createClient({ ...pending, session: pending.temp_session || '' });
    await client.connect();

    if (await client.checkAuthorization()) {
      await finishTelegramLogin({ chatId: pending.chat_id, pending, client });
      return { valid: true, connected: true };
    }

    const livePending = {
      ...pending,
      temp_session: client.session.save(),
      live_started_at: new Date().toISOString(),
    };
    await savePendingLogin(livePending);

    await client.signInUserWithQrCode(
      {
        apiId: Number(livePending.api_id),
        apiHash: String(livePending.api_hash),
      },
      {
        qrCode: async ({ token, expires }) => {
          const encodedToken = Buffer.from(token).toString('base64url');
          const refreshed = {
            ...livePending,
            temp_session: client.session.save(),
            qr_generated_at: new Date().toISOString(),
            qr_expires: Number(expires || 0),
          };
          await savePendingLogin(refreshed);
          await onQr?.({
            deep_link: `tg://login?token=${encodedToken}`,
            expires: Number(expires || 0),
          });
        },
        onError: async () => true,
        abortSignal,
      },
    );

    await finishTelegramLogin({ chatId: livePending.chat_id, pending: livePending, client });
    return { valid: true, connected: true };
  } catch (error) {
    if (error?.name === 'AbortError') return { valid: true, connected: false, aborted: true };
    throw error;
  } finally {
    await client?.disconnect().catch(() => {});
  }
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
      'Lepas ni bot bagi Live QR Page rasmi Telegram. Tak perlu hantar OTP/password ke bot.',
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

  if (state.mode === 'TG_CONNECT_API') {
    await deleteSensitiveInput(message);
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
      qr_view_key: randomBytes(24).toString('base64url'),
    };
    await savePendingLogin(pending);
    await setSetting('admin_state', { mode: 'TG_CONNECT_QR' });

    await sendQrApproveMessage(chatId, qrPageUrl(pending.qr_view_key));
    return true;
  }

  if (state.mode === 'TG_CONNECT_QR') {
    const pending = await getPendingLogin();
    if (!pending?.api_id || !pending?.api_hash || !pending?.chat_id || !pending?.qr_view_key) {
      await setSetting('admin_state', null);
      await rawBot('sendMessage', { chat_id: chatId, text: 'Secure login state dah tamat. Jalankan /tglogin semula.' });
      return true;
    }

    await rawBot('sendMessage', {
      chat_id: chatId,
      text: [
        'Live QR Page mesti kekal terbuka masa scan supaya bot boleh terima approval Telegram.',
        'Bila scan berjaya, bot akan auto hantar ✅ connected — tak perlu taip check lagi.',
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [[{ text: '🖥️ Open Live QR Page', url: qrPageUrl(pending.qr_view_key) }]],
      },
    });
    return true;
  }

  if (['TG_CONNECT_PHONE', 'TG_CONNECT_CODE', 'TG_CONNECT_PASSWORD', 'TG_CONNECT_WEB_CODE', 'TG_CONNECT_WEB_PASSWORD'].includes(state.mode)) {
    await clearPendingLogin();
    await setSetting('admin_state', null);
    await rawBot('sendMessage', {
      chat_id: chatId,
      text: 'Flow login lama dah dihentikan. Jalankan /tglogin semula untuk authorization QR rasmi Telegram.',
    });
    return true;
  }

  return false;
}

async function sendQrApproveMessage(chatId, pageUrl) {
  await rawBot('sendMessage', {
    chat_id: chatId,
    text: [
      '📲 Step 2/2 — Telegram Live QR Authorization',
      '',
      '1. Buka Live QR Page pada PC/laptop atau skrin kedua dan BIARKAN page tu terbuka.',
      '2. Pada iPhone utama: Telegram → Settings → Devices → Add Device / Link Desktop Device.',
      '3. Scan QR yang sedang dipaparkan.',
      '4. Bot akan auto-detect approval dan simpan session. Tak perlu taip check.',
      '',
      'QR akan refresh sendiri dalam page yang sama kalau belum sempat scan.',
    ].join('\n'),
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: '🖥️ Open Live QR Page', url: pageUrl }]],
    },
  });
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
