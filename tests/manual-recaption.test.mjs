import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isForwardedMessage } from '../lib/bot/features/recaption-collection.js';
import {
  RECAPTION_MAX_ITEMS_PER_INVOCATION,
  RECAPTION_MAX_WORK_MS,
  shouldPersistRecaptionPause,
} from '../lib/bot/features/recaption-runner.js';
import { validateProcessedAgainstProfile } from '../lib/bot/features/recaption.js';

test('forward detector supports current and legacy Telegram forwarding fields', () => {
  assert.equal(isForwardedMessage({ forward_origin: { type: 'channel' } }), true);
  assert.equal(isForwardedMessage({ forward_date: 123 }), true);
  assert.equal(isForwardedMessage({ forward_from_chat: { id: -1001 } }), true);
  assert.equal(isForwardedMessage({ forward_sender_name: 'Hidden User' }), true);
  assert.equal(isForwardedMessage({ message_id: 1, photo: [{}] }), false);
});

test('forwarded media is collected before existing immediate recaption path', async () => {
  const source = await readFile(new URL('../lib/bot/features/message-router.js', import.meta.url), 'utf8');
  assert.match(source, /if \(isForwardedMessage\(message\)\)/);
  assert.match(source, /collectForwardedQueueItem/);
  assert.match(source, /aku belum recaption apa-apa/);
  assert.ok(source.indexOf('isForwardedMessage(message)') < source.lastIndexOf('prepareMedia(message)'));
});

test('/recaption is a registered explicit command', async () => {
  const source = await readFile(new URL('../lib/bot/commands/router.js', import.meta.url), 'utf8');
  const command = await readFile(new URL('../lib/bot/commands/recaption.js', import.meta.url), 'utf8');
  assert.match(source, /import \* as recaption from '\.\/recaption\.js'/);
  assert.match(source, /\brecaption,\n/);
  assert.match(command, /closeActiveRecaptionCollection/);
  assert.match(command, /kickRecaptionWorker/);
  assert.match(command, /nothing_collected/);
});

test('manual recaption worker is bounded and exact-session scoped', async () => {
  assert.equal(RECAPTION_MAX_ITEMS_PER_INVOCATION, 8);
  assert.equal(RECAPTION_MAX_WORK_MS, 12_000);
  const collection = await readFile(new URL('../lib/bot/features/recaption-collection.js', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../lib/bot/features/recaption-runner.js', import.meta.url), 'utf8');
  assert.match(collection, /recaption_session_id=eq\./);
  assert.match(collection, /order=source_message_id\.asc,created_at\.asc/);
  assert.match(runner, /listRecaptionSessionItems\(session\.admin_chat_id, session\.id, \['PENDING'\]/);
  assert.match(runner, /should_continue: true/);
});

test('duplicate recaption workers are serialized by an expiring lease', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260916170000_manual_recaption_collection.sql', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../lib/bot/features/recaption-runner.js', import.meta.url), 'utf8');
  assert.match(sql, /claim_recaption_worker/);
  assert.match(sql, /worker_lease_until > now\(\)/);
  assert.match(sql, /'busy'/);
  assert.match(sql, /release_recaption_worker/);
  assert.match(runner, /claimRecaptionWorker/);
  assert.match(runner, /finally \{/);
  assert.match(runner, /releaseRecaptionWorker/);
});

test('fast /resume cannot be overwritten by the old pausing worker', () => {
  assert.equal(shouldPersistRecaptionPause({ reviewStillActive: true }), true);
  assert.equal(shouldPersistRecaptionPause({ reviewStillActive: false }), false);
});

test('new-format pause remembers recaption session and /resume returns to same worker', async () => {
  const gate = await readFile(new URL('../lib/bot/features/format-gate.js', import.meta.url), 'utf8');
  const resume = await readFile(new URL('../lib/bot/commands/resume.js', import.meta.url), 'utf8');
  assert.match(gate, /recaption_session_id: item\?\.recaption_session_id/);
  assert.match(gate, /recaption_session_id: review\?\.recaption_session_id/);
  assert.match(resume, /review\?\.confirmed && review\.recaption_session_id/);
  assert.match(resume, /kickRecaptionWorker/);
});

test('collection migration is atomic, replay-safe and rotates before recaption', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260916170000_manual_recaption_collection.sql', import.meta.url), 'utf8');
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /recaption_sessions_one_collecting_per_admin/);
  assert.match(sql, /source_message_id = p_source_message_id/);
  assert.match(sql, /'replay', true/);
  assert.match(sql, /set status = 'PROCESSING'/i);
  assert.match(sql, /worker_secret = coalesce\(worker_secret, gen_random_uuid\(\)::text\)/);
});

test('Translate ON fails validation while source-script text remains', () => {
  const profile = {
    footer_html: null,
    actions: {
      take_title: true,
      take_serial: false,
      translate: true,
      remove_hashtags: true,
      add_footer: false,
    },
  };
  const bad = validateProcessedAgainstProfile({
    title: 'Kettler Astro-Эллиптический тренажер',
    finalCaptionHtml: '<b>Kettler Astro-Эллиптический тренажер</b>',
  }, profile, {});
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /translation still contains non-Latin source text/);

  const good = validateProcessedAgainstProfile({
    title: 'Kettler Astro Elliptical Trainer',
    finalCaptionHtml: '<b>Kettler Astro Elliptical Trainer</b>',
  }, profile, {});
  assert.equal(good.ok, true);
});

test('known translated formats are finalized through the failover recaption path', async () => {
  const runner = await readFile(new URL('../lib/bot/features/recaption-runner.js', import.meta.url), 'utf8');
  assert.match(runner, /finalizeTranslatedRecaptionItem/);
  assert.match(runner, /recaption_final_translation_validation/);
  assert.match(runner, /status: 'FAILED'/);
});

test('invalid translated recaption cannot escape through single send or SEND ALL', async () => {
  const sendOne = await readFile(new URL('../lib/bot/features/send-one.js', import.meta.url), 'utf8');
  const sendAll = await readFile(new URL('../api/telegram-sendall.js', import.meta.url), 'utf8');
  assert.match(sendOne, /send_item_blocked_invalid_translation/);
  assert.match(sendOne, /blocked: 'invalid_translation'/);
  assert.match(sendOne, /translation unavailable\|translate failed\|translation still contains non-latin\|recaption validation failed/i);
  assert.match(sendAll, /isInvalidTranslationFailure/);
  assert.match(sendAll, /Blocked: recaption translation\/validation is not valid yet/);
  assert.match(sendAll, /markBatchItemSkipped/);
});

test('format manager can reapply a format to the latest unsent recaption batch', async () => {
  const manager = await readFile(new URL('../lib/bot/features/format-manager.js', import.meta.url), 'utf8');
  const callbacks = await readFile(new URL('../lib/bot/features/preview-callbacks.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../lib/bot/features/format-batch-apply.js', import.meta.url), 'utf8');
  const apiWorker = await readFile(new URL('../api/recaption-worker.js', import.meta.url), 'utf8');

  assert.match(manager, /APPLY CURRENT BATCH/);
  assert.match(callbacks, /fmtmgr_applybatch/);
  assert.match(worker, /\['PENDING', 'READY', 'FAILED'\]/);
  assert.match(worker, /\['SENT', 'SKIPPED'\]\.includes/);
  assert.match(worker, /syncSent: false/);
  assert.match(apiWorker, /mode.*apply_profile/);
});
