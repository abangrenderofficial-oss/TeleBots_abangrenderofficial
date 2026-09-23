import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeCanonicalSerial,
  validateProcessedAgainstProfile,
} from '../lib/bot/features/recaption.js';

test('canonical serial is kept exactly once when extractor repeats it inside title', () => {
  const serial = '2867326.5ecab89c8fa0f';
  const processed = normalizeCanonicalSerial({
    serial,
    title: `${serial}\n${serial} ZEFIR chair by Baxter`,
    finalCaptionHtml: `<b>${serial}\n${serial} ZEFIR chair by Baxter</b>\n\nfooter`,
  });

  assert.equal(processed.title, `${serial}\nZEFIR chair by Baxter`);
  assert.equal((processed.title.match(/2867326\.5ecab89c8fa0f/g) || []).length, 1);
  assert.match(processed.finalCaptionHtml, /<b>2867326\.5ecab89c8fa0f\nZEFIR chair by Baxter<\/b>/);
});

test('serial validation rejects a title that still contains the canonical serial twice', () => {
  const serial = '2452183.5cecde59cf4ad';
  const result = validateProcessedAgainstProfile({
    title: `${serial}\n${serial} Restaurant bar 4`,
    finalCaptionHtml: `<b>${serial}\n${serial} Restaurant bar 4</b>`,
  }, {
    actions: {
      take_title: true,
      take_serial: true,
      translate: false,
      remove_hashtags: true,
      add_footer: false,
    },
  }, {
    original_caption: `${serial} #ресторан #барнаястойка Restaurant bar 4`,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /canonical serial appears more than once/);
});

test('direct media prepares strictly before the atomic ordered sender and DB scheduled continuation', async () => {
  const worker = await readFile(new URL('../lib/bot/features/immediate-media-worker.js', import.meta.url), 'utf8');
  const apiWorker = await readFile(new URL('../api/recaption-worker.js', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../supabase/migrations/20260924231000_prepared_preview_sender.sql', import.meta.url), 'utf8');

  assert.match(worker, /recaptionItemWithProfile/);
  assert.match(worker, /reason: 'immediate_prepare'/);
  assert.match(worker, /forceTranslateAllLanguages: true/);
  assert.match(worker, /keepPending: true/);
  assert.match(worker, /status: 'FAILED'/);
  assert.match(worker, /claim_queue_preview_send/);
  assert.match(worker, /schedule_immediate_media_worker/);
  assert.match(apiWorker, /scheduleImmediateMediaContinuation/);
  assert.doesNotMatch(apiWorker, /Immediate media continuation kick failed/);
  assert.match(migration, /net\.http_post/);
  assert.match(migration, /'mode', 'immediate_media'/);
});
