import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { parseCommand } from '../lib/bot/core/command.js';
import { registeredCommandNames } from '../lib/bot/commands/router.js';
import { classifyBatchCallback } from '../lib/bot/batch/router.js';

const expectedCommands = [
  'aitest',
  'clearchat',
  'connect',
  'forget',
  'help',
  'memories',
  'menu',
  'pending',
  'remember',
  'resetbatch',
  'resume',
  'setcaption',
  'start',
  'stats',
  'stop',
  'total',
  'version',
  'whoami',
];

test('command parser handles bot suffix and args without cross-command matching', () => {
  assert.deepEqual(parseCommand('/menu'), { name: 'menu', args: '', raw: '/menu' });
  assert.deepEqual(parseCommand('/remember hello boss'), {
    name: 'remember',
    args: 'hello boss',
    raw: '/remember hello boss',
  });
  assert.deepEqual(parseCommand('/STOP@ARCoordinatorBot'), {
    name: 'stop',
    args: '',
    raw: '/STOP@ARCoordinatorBot',
  });
  assert.equal(parseCommand('hello /menu'), null);
});

test('all supported commands are registered centrally', () => {
  assert.deepEqual(registeredCommandNames, [...expectedCommands].sort());
});

test('each command domain has its own owner module', async () => {
  const files = [
    'menu.js', 'help.js', 'whoami.js', 'version.js', 'aitest.js', 'stats.js',
    'total.js', 'pending.js', 'memories.js', 'remember.js', 'forget.js',
    'clearchat.js', 'setcaption.js', 'stop.js', 'resume.js', 'resetbatch.js',
    'connect.js',
  ];
  await Promise.all(files.map((file) => access(new URL(`../lib/bot/commands/${file}`, import.meta.url))));
});

test('batch callback router owns only batch callbacks', () => {
  assert.deepEqual(classifyBatchCallback('sendall'), { type: 'sendall' });
  assert.deepEqual(classifyBatchCallback('resendall:item-7'), { type: 'resendall', id: 'item-7' });
  assert.deepEqual(classifyBatchCallback('hard_resume'), { type: 'resume' });
  assert.deepEqual(classifyBatchCallback('reset_exact:B123'), { type: 'reset_exact', id: 'B123' });
  assert.deepEqual(classifyBatchCallback('reset_exact_confirm:B123'), { type: 'reset_exact_confirm', id: 'B123' });
  assert.equal(classifyBatchCallback('send:item-7'), null);
  assert.equal(classifyBatchCallback('edit:item-7'), null);
  assert.equal(classifyBatchCallback('fmt_title:item-7'), null);
});

test('production ingress is thin and legacy /api/telegram is only an alias', async () => {
  const safe = await readFile(new URL('../api/telegram-safe-destination.js', import.meta.url), 'utf8');
  const legacyAlias = await readFile(new URL('../api/telegram.js', import.meta.url), 'utf8');

  assert.match(safe, /routeUpdate/);
  assert.doesNotMatch(safe, /createExplicitBatch|agentAssistant|processMediaWithProfile|setWebhook/);
  assert.match(legacyAlias, /telegram-safe-destination\.js/);
  assert.doesNotMatch(legacyAlias, /agentAssistant|continueSendBatch|handleCallback/);
});

test('normal Telegram transport cannot self-register or heal webhook', async () => {
  const transport = await readFile(new URL('../lib/telegram.js', import.meta.url), 'utf8');
  const telegramStart = transport.indexOf('export async function telegram(');
  const repairStart = transport.indexOf('export async function repairTelegramWebhook(');
  assert.ok(telegramStart >= 0 && repairStart > telegramStart);

  const normalTransport = transport.slice(telegramStart, repairStart);
  assert.doesNotMatch(normalTransport, /rawTelegram\s*\([^\n]*['"]setWebhook['"]|ensureCallbackWebhookSupport/);
  assert.match(transport.slice(repairStart), /['"]setWebhook['"]/);
});

test('live feature router does not import historical api/telegram monolith', async () => {
  const updateRouter = await readFile(new URL('../lib/bot/update-router.js', import.meta.url), 'utf8');
  const featureRouter = await readFile(new URL('../lib/bot/features/router.js', import.meta.url), 'utf8');
  assert.doesNotMatch(updateRouter, /api\/telegram|legacy-adapter/);
  assert.doesNotMatch(featureRouter, /api\/telegram|legacy-adapter/);
});

test('reset confirmation clears pending state explicitly and ignores already processed ids', async () => {
  const reset = await readFile(new URL('../lib/bot/batch/reset.js', import.meta.url), 'utf8');
  assert.match(reset, /async function clearSetting\(/);
  assert.match(reset, /filter\(\(id\) => !processedSet\.has\(id\)\)/);
  assert.match(reset, /filter\(\(id\) => !set\.has\(id\)\)/);
  assert.doesNotMatch(reset, /setSetting\(`reset_(?:exact|legacy)_pending:\$\{chatId\}`, null\)/);
});

test('entire live isolated router graph imports successfully', async () => {
  const update = await import('../lib/bot/update-router.js');
  const safeEndpoint = await import('../api/telegram-safe-destination.js');
  const compatibilityEndpoint = await import('../api/telegram.js');

  assert.equal(typeof update.routeUpdate, 'function');
  assert.equal(typeof safeEndpoint.default, 'function');
  assert.equal(compatibilityEndpoint.default, safeEndpoint.default);
});
