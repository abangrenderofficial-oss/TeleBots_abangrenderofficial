import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  IMMEDIATE_MEDIA_AUDIT_CONCURRENCY,
  IMMEDIATE_MEDIA_CONCURRENCY,
  IMMEDIATE_MEDIA_MAX_ITEMS_PER_INVOCATION,
  IMMEDIATE_MEDIA_SENDER_CONCURRENCY,
} from '../lib/bot/features/immediate-media-worker.js';
import { getAiConcurrencyLimits } from '../lib/ai-concurrency.js';

test('direct media uses ten background preparers behind one ordered sender', async () => {
  assert.equal(IMMEDIATE_MEDIA_CONCURRENCY, 10);
  assert.equal(IMMEDIATE_MEDIA_MAX_ITEMS_PER_INVOCATION, 10);
  assert.equal(IMMEDIATE_MEDIA_SENDER_CONCURRENCY, 1);
  assert.equal(IMMEDIATE_MEDIA_AUDIT_CONCURRENCY, 3);
  assert.deepEqual(getAiConcurrencyLimits(), { translation: 3, vision: 2 });

  const worker = await readFile(new URL('../lib/bot/features/immediate-media-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /const prepPromises = wave\.map/);
  assert.match(worker, /await prepPromises\[index\]/);
  assert.match(worker, /sendPreparedPreviewOnce/);
  assert.match(worker, /claim_queue_preview_send/);
  assert.match(worker, /complete_queue_preview_send/);
  assert.match(worker, /release_queue_preview_send/);
  assert.match(worker, /immediate_prepared_at/);
  assert.match(worker, /forceTranslateAllLanguages: true/);
  assert.match(worker, /maybeAutoNameUntitledDocument/);
  assert.match(worker, /auditSentItems/);
  assert.match(worker, /hard boundary/);
  assert.match(worker, /recaption_session_id/);
});

test('prepared direct items remain PENDING until the single sender commits preview id', async () => {
  const worker = await readFile(new URL('../lib/bot/features/immediate-media-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /keepPending: true/);
  assert.match(worker, /status: 'PENDING',[\s\S]*immediate_prepared_at/);
  assert.match(worker, /PENDING without prepared_at is the hard order barrier/);
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
  assert.match(api, /scheduleImmediateMediaContinuation/);
});

test('/resume returns confirmed direct-upload queues to the immediate worker', async () => {
  const resume = await readFile(new URL('../lib/bot/commands/resume.js', import.meta.url), 'utf8');
  assert.match(resume, /immediate_media_queue_floor/);
  assert.match(resume, /kickImmediateMediaWorker/);
});

test('preview sender migration has atomic claim complete release and longer continuation timeout', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260924231000_prepared_preview_sender.sql', import.meta.url), 'utf8');
  assert.match(migration, /claim_queue_preview_send/);
  assert.match(migration, /complete_queue_preview_send/);
  assert.match(migration, /release_queue_preview_send/);
  assert.match(migration, /immediate_prepared_at/);
  assert.match(migration, /timeout_milliseconds := 60000/);
});
