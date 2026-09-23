import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('new-format gate persists SEND hard-stop before publishing review state', async () => {
  const source = await readFile(new URL('../lib/bot/features/format-gate.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function pauseForNewFormat');
  const end = source.indexOf('export async function confirmFormatStep');
  const body = source.slice(start, end);
  const sendPause = body.indexOf('await enforceSendPause(chatId, review, now)');
  const pipelinePause = body.indexOf('await pausePipeline({');
  const reviewWrite = body.indexOf('await setSettingWithRetry(reviewKey(chatId), review)');
  assert.ok(sendPause >= 0, 'SEND pause must be enforced');
  assert.ok(pipelinePause >= 0, 'master pipeline pause must be enforced');
  assert.ok(reviewWrite >= 0, 'review gate must be persisted');
  assert.ok(sendPause < reviewWrite, 'SEND pause must be durable before review gate');
  assert.ok(pipelinePause < reviewWrite, 'master pipeline pause must be durable before review gate');
});

test('existing partial review repairs both SEND and master pipeline gates before returning', async () => {
  const source = await readFile(new URL('../lib/bot/features/format-gate.js', import.meta.url), 'utf8');
  const start = source.indexOf('if (current?.paused) {');
  const end = source.indexOf('\n  const item = await getQueueItem', start);
  const body = source.slice(start, end);

  assert.match(body, /await enforceSendPause\(chatId, current, now\)/);
  assert.match(body, /await pausePipeline\(\{/);
  assert.match(body, /reason: PIPELINE_REASONS\.NEW_FORMAT/);
  assert.match(body, /return current/);

  const sendPause = body.indexOf('await enforceSendPause(chatId, current, now)');
  const pipelinePause = body.indexOf('await pausePipeline({');
  const returnCurrent = body.indexOf('return current');
  assert.ok(sendPause >= 0 && sendPause < returnCurrent, 'SEND gate repair must happen before return');
  assert.ok(pipelinePause >= 0 && pipelinePause < returnCurrent, 'master gate repair must happen before return');
});

test('critical setting writes retry transient persistence failures', async () => {
  const source = await readFile(new URL('../lib/bot/features/format-gate.js', import.meta.url), 'utf8');
  assert.match(source, /SETTING_RETRY_DELAYS_MS = \[0, 120, 320\]/);
  assert.match(source, /async function setSettingWithRetry/);
  assert.match(source, /for \(const delayMs of SETTING_RETRY_DELAYS_MS\)/);
});
