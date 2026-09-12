import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAuthorizedTelegramWebhook,
  telegramWebhookSecret,
} from '../lib/bot/core/telegram-webhook-auth.js';
import safeHandler from '../api/telegram-safe-destination.js';
import repairHandler from '../api/repair-webhook.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() { return this; },
  };
}

test('webhook accepts only the configured Telegram secret header', () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
  try {
    const secret = telegramWebhookSecret();
    assert.match(secret, /^[a-f0-9]{64}$/);
    assert.equal(isAuthorizedTelegramWebhook({ headers: {} }), false);
    assert.equal(isAuthorizedTelegramWebhook({ headers: { 'x-telegram-bot-api-secret-token': 'wrong' } }), false);
    assert.equal(isAuthorizedTelegramWebhook({ headers: { 'x-telegram-bot-api-secret-token': [secret] } }), false);
    assert.equal(isAuthorizedTelegramWebhook({ headers: { 'x-telegram-bot-api-secret-token': secret } }), true);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

test('unsigned webhook POST is rejected before processing an admin command', async () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
  try {
    const res = response();
    await safeHandler({
      method: 'POST',
      headers: {},
      body: { message: { from: { id: '6749355196' }, chat: { id: 6749355196, type: 'private' }, text: '/resume' } },
    }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { ok: false, error: 'Unauthorized webhook' });
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

test('webhook repair registers the same secret without disclosing it', async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/setWebhook')) return { ok: true, json: async () => ({ ok: true, result: true }) };
    return { ok: true, json: async () => ({ ok: true, result: { url: 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram-safe-destination', pending_update_count: 0 } }) };
  };
  try {
    const res = response();
    await repairHandler({ method: 'POST' }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.secret_token, telegramWebhookSecret());
    assert.equal(calls[0].body.drop_pending_updates, false);
    assert.equal(res.body.secret_token_configured, true);
    assert.equal(JSON.stringify(res.body).includes(telegramWebhookSecret()), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
  }
});
