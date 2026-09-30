import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  extractTelegramPostLink,
  parseTelegramPreviewHtml,
} from '../lib/bot/features/telegram-link-import.js';
import {
  getTelegramUserSessionConfig,
  telegramUserSessionConfigured,
} from '../lib/bot/core/telegram-user-client.js';

test('Telegram importer parses the exact public dummy link', () => {
  assert.deepEqual(extractTelegramPostLink('https://t.me/free3dsky/29983'), {
    url: 'https://t.me/free3dsky/29983',
    kind: 'public',
    sourceChatId: '@free3dsky',
    messageId: 29983,
    channel: 'free3dsky',
  });
});

test('Telegram importer parses private /c links and optional topic links', () => {
  assert.deepEqual(extractTelegramPostLink('https://t.me/c/1234567890/9876'), {
    url: 'https://t.me/c/1234567890/9876',
    kind: 'private',
    sourceChatId: '-1001234567890',
    messageId: 9876,
    channel: null,
  });

  const topic = extractTelegramPostLink('https://t.me/examplechannel/42/999?single=1');
  assert.equal(topic.channel, 'examplechannel');
  assert.equal(topic.messageId, 999);
});

test('Telegram public preview marks unsupported Telegram-only media instead of pretending it is empty', () => {
  const preview = parseTelegramPreviewHtml(`
    <div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="free3dsky/29983">
      <div class="message_media_not_supported_wrap">Please open Telegram to view this post</div>
    </div>
  `, { channel: 'free3dsky', messageId: 29983 });

  assert.equal(preview.unsupported, true);
  assert.equal(preview.media.length, 0);
  assert.equal(preview.messageId, 29983);
});

test('Telegram public preview extracts ordinary photo and text posts', () => {
  const preview = parseTelegramPreviewHtml(`
    <div class="tgme_widget_message js-widget_message">
      <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn.example.com/photo.jpg')"></a>
      <div class="tgme_widget_message_text js-message_text">Hello<br>world</div>
    </div>
  `);

  assert.equal(preview.unsupported, false);
  assert.equal(preview.text, 'Hello\nworld');
  assert.deepEqual(preview.media, [
    { type: 'photo', url: 'https://cdn.example.com/photo.jpg' },
  ]);
});

test('MTProto session config still accepts ZIP-compatible env names as fallback', async () => {
  const keys = [
    'TELEGRAM_API_ID',
    'TELEGRAM_API_HASH',
    'TELEGRAM_SESSION_STRING',
    'API_ID',
    'API_HASH',
    'STRING',
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    for (const key of keys) delete process.env[key];
    assert.equal(await telegramUserSessionConfigured(), false);
    assert.equal(await getTelegramUserSessionConfig(), null);

    process.env.API_ID = '12345';
    process.env.API_HASH = 'hash-value';
    process.env.STRING = 'session-value';
    assert.deepEqual(await getTelegramUserSessionConfig(), {
      apiId: 12345,
      apiHash: 'hash-value',
      sessionString: 'session-value',
      source: 'environment',
    });
    assert.equal(await telegramUserSessionConfigured(), true);
  } finally {
    for (const key of keys) {
      if (before[key] == null) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test('Telegram links are routed before general AI text chat', async () => {
  const source = await fs.readFile(new URL('../lib/bot/features/message-router.js', import.meta.url), 'utf8');
  const importerIndex = source.indexOf('handleTelegramPostLink({ message })');
  const aiIndex = source.indexOf('handleAgentText({ chatId: message.chat.id, message, state })');

  assert.ok(importerIndex > 0, 'Telegram importer must be wired into message router');
  assert.ok(aiIndex > importerIndex, 'Telegram links must not fall through into AI chat first');
});

test('Telegram login state is delegated through state-input and kept out of generic formatting logic', async () => {
  const source = await fs.readFile(new URL('../lib/bot/features/state-input.js', import.meta.url), 'utf8');
  assert.match(source, /handleTelegramConnectInput/);
  assert.doesNotMatch(source, /new TelegramClient|auth\.SignIn/);
});
