import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  IMMEDIATE_MEDIA_CONCURRENCY,
  IMMEDIATE_MEDIA_MAX_ITEMS_PER_INVOCATION,
} from '../lib/bot/features/immediate-media-worker.js';

test('direct media worker uses three-way bounded concurrency', async () => {
  assert.equal(IMMEDIATE_MEDIA_CONCURRENCY, 3);
  assert.equal(IMMEDIATE_MEDIA_MAX_ITEMS_PER_INVOCATION, 3);

  const worker = await readFile(new URL('../lib/bot/features/immediate-media-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /Promise\.all\(wave\.map/);
  assert.match(worker, /claim_immediate_media_worker/);
  assert.match(worker, /release_immediate_media_worker/);
  assert.match(worker, /hard boundary/);
  assert.match(worker, /recaption_session_id/);
  assert.match(worker, /status \|\| ''\)\.toUpperCase\(\) === 'PENDING'/);
});

test('non-forwarded uploads queue into the immediate worker instead of inline processing', async () => {
  const router = await readFile(new URL('../lib/bot/features/message-router.js', import.meta.url), 'utf8');
  assert.match(router, /enqueueImmediateMedia/);
  assert.doesNotMatch(router, /await prepareMedia\(message\)/);
});

test('existing recaption endpoint hosts immediate media mode without a new serverless function', async () => {
  const api = await readFile(new URL('../api/recaption-worker.js', import.meta.url), 'utf8');
  assert.match(api, /mode === 'immediate_media'/);
  assert.match(api, /runImmediateMediaQueue/);
  assert.match(api, /kickImmediateMediaWorker/);
});

test('/resume returns confirmed direct-upload queues to the three-way worker', async () => {
  const resume = await readFile(new URL('../lib/bot/commands/resume.js', import.meta.url), 'utf8');
  assert.match(resume, /immediate_media_queue_floor/);
  assert.match(resume, /kickImmediateMediaWorker/);
  assert.match(resume, /worker 3-serentak aktif/);
});
