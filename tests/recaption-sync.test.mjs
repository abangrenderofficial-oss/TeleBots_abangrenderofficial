import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canSyncSentItem,
  normalizeSentSyncMode,
  shouldAutoSync,
  syncSentItemById,
} from '../lib/bot/features/sent-sync.js';
import {
  compareRecaptionResult,
  validateProcessedAgainstProfile,
} from '../lib/bot/features/recaption.js';
import { formatConfirmLabel } from '../lib/bot/features/format-gate.js';
import { selectPausedQueueWindow } from '../lib/bot/features/format-resume.js';

test('sent edit sync supports both tested policies but defaults safely to button', () => {
  assert.equal(normalizeSentSyncMode(null), 'button');
  assert.equal(normalizeSentSyncMode('button'), 'button');
  assert.equal(normalizeSentSyncMode('auto'), 'auto');
  assert.equal(shouldAutoSync('button'), false);
  assert.equal(shouldAutoSync('auto'), true);
  assert.equal(shouldAutoSync('button', true), true);
});

test('sent caption sync works for any media item with an exact Telegram destination occurrence', () => {
  for (const media_kind of ['document', 'photo', 'video', 'animation', 'audio']) {
    assert.equal(canSyncSentItem({
      status: 'SENT',
      media_kind,
      destination_chat_id: '-100123',
      destination_message_id: 456,
    }), true);
  }
  assert.equal(canSyncSentItem({ status: 'READY', destination_chat_id: '-100123', destination_message_id: 456 }), false);
  assert.equal(canSyncSentItem({ status: 'SENT', destination_chat_id: '-100123', destination_message_id: null }), false);
});

test('recaption validation enforces confirmed format rules instead of silently drifting', () => {
  const profile = {
    id: 'fmt-test',
    actions: {
      take_title: true,
      take_serial: true,
      remove_hashtags: true,
      add_footer: true,
      translate: false,
    },
    footer_html: '<a href="https://example.com">Footer</a>',
  };
  const item = {
    original_caption: 'ABC-12345\nPremium Chair\n#3dmodel',
    file_name: 'chair.rar',
  };
  const good = {
    title: 'ABC-12345\nPremium Chair',
    finalCaptionHtml: '<b>ABC-12345\nPremium Chair</b>\n\n<a href="https://example.com">Footer</a>',
  };
  assert.deepEqual(validateProcessedAgainstProfile(good, profile, item), { ok: true, errors: [] });

  const bad = {
    title: 'Premium Chair #3dmodel',
    finalCaptionHtml: '<b>Premium Chair #3dmodel</b>',
  };
  const result = validateProcessedAgainstProfile(bad, profile, item);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' | '), /hashtag remained/);
  assert.match(result.errors.join(' | '), /serial missing/);
  assert.match(result.errors.join(' | '), /footer missing/);
});

test('recaption comparison catches any title or exact HTML caption mismatch', () => {
  const a = { title: 'Chair X', finalCaptionHtml: '<b>Chair X</b>\n\nFooter' };
  assert.equal(compareRecaptionResult(a, { ...a }), true);
  assert.equal(compareRecaptionResult(a, { ...a, title: 'Chair Y' }), false);
  assert.equal(compareRecaptionResult(a, { ...a, finalCaptionHtml: '<b>Chair X</b> Footer' }), false);
});

test('new format requires two explicit confirmations and still requires /resume', () => {
  const base = { item_id: 'I1', confirmed: false, confirm_stage: 0 };
  assert.equal(formatConfirmLabel(base, 'I1'), '✅ CONFIRM FORMAT');
  assert.equal(formatConfirmLabel({ ...base, confirm_stage: 1 }, 'I1'), '✅ CONFIRM SEKALI LAGI');
  assert.equal(formatConfirmLabel({ ...base, confirm_stage: 2, confirmed: true }, 'I1'), '✅ FORMAT CONFIRMED · /resume');
  assert.equal(formatConfirmLabel(base, 'OTHER'), null);
});

test('format resume never revives historical pending rows before the paused upload window', () => {
  const review = {
    queue_source_chat_id: '42',
    queue_start_source_message_id: 100,
    queue_start_created_at: '2026-09-12T10:00:00.000Z',
    created_at: '2026-09-12T10:00:01.000Z',
  };
  const rows = [
    { id: 'old', admin_chat_id: '42', source_chat_id: '42', source_message_id: 90, status: 'PENDING', created_at: '2026-09-11T10:00:00Z' },
    { id: 'gate', admin_chat_id: '42', source_chat_id: '42', source_message_id: 100, status: 'READY', created_at: '2026-09-12T10:00:00Z' },
    { id: 'q1', admin_chat_id: '42', source_chat_id: '42', source_message_id: 101, status: 'PENDING', created_at: '2026-09-12T10:00:02Z' },
    { id: 'q2', admin_chat_id: '42', source_chat_id: '42', source_message_id: 102, status: 'FAILED', created_at: '2026-09-12T10:00:03Z' },
    { id: 'other-chat', admin_chat_id: '42', source_chat_id: '99', source_message_id: 103, status: 'PENDING', created_at: '2026-09-12T10:00:04Z' },
  ];
  assert.deepEqual(selectPausedQueueWindow(rows, review, 42).map((row) => row.id), ['q1', 'q2']);
});

test('ordered preview failure is isolated from caption resume processing', async () => {
  const source = await readFile(new URL('../lib/bot/features/media.js', import.meta.url), 'utf8');
  assert.match(source, /Ordered preview delivery failed:/);
  assert.match(source, /Preview delivery failed:/);
  assert.match(source, /Future flushes can retry this exact preview/);
});

test('media pipeline queues later uploads while format review is paused', async () => {
  const source = await readFile(new URL('../lib/bot/features/media.js', import.meta.url), 'utf8');
  assert.match(source, /isFormatPipelinePaused\(message\.chat\.id\)/);
  assert.match(source, /status: 'PENDING'/);
  assert.match(source, /pauseForNewFormat/);
  assert.match(source, /format_profile_confirmed:/);
});

test('/resume cannot bypass unconfirmed format and drains scoped caption queue first', async () => {
  const command = await readFile(new URL('../lib/bot/commands/resume.js', import.meta.url), 'utf8');
  const control = await readFile(new URL('../lib/bot/batch/control.js', import.meta.url), 'utf8');
  assert.match(command, /blocked: 'format_not_confirmed'/);
  assert.ok(command.indexOf('resumeFormatQueue') < command.lastIndexOf('resumeLatest'));
  assert.match(control, /format_review_gate:/);
  assert.match(control, /format_queue_pending/);
});

test('/resetbatch exact mode uses ledger plus sent-item ids and is idempotent', async () => {
  const reset = await readFile(new URL('../lib/bot/batch/reset.js', import.meta.url), 'utf8');
  assert.match(reset, /send_batch_messages\?batch_id=/);
  assert.match(reset, /send_batch_items\?batch_id=/);
  assert.match(reset, /reset_exact_processed:/);
  assert.match(reset, /filter\(\(id\) => !processedSet\.has\(id\)\)/);
  assert.match(reset, /already_processed: true/);
  assert.doesNotMatch(reset, /destination_message_id\s*>=|message_id\s*>=/);
});

test('AUTO repairs an older Telegram edit that completes after the newest caption', async () => {
  let currentCaption = '<b>First</b>';
  const sent = [];
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  const firstReleasePromise = new Promise((resolve) => { releaseFirst = resolve; });
  const getItemFn = async () => ({
    id: 'item-1',
    status: 'SENT',
    destination_chat_id: '-100123',
    destination_message_id: 456,
    final_caption_html: currentCaption,
  });
  const telegramFn = async (_method, payload) => {
    if (payload.caption === '<b>First</b>') {
      firstStarted();
      await firstReleasePromise;
    }
    sent.push(payload.caption);
  };
  const persistFn = async () => null;
  const options = { mode: 'auto', getItemFn, telegramFn, persistFn };

  const first = syncSentItemById('item-1', options);
  await firstStartedPromise;
  currentCaption = '<b>Latest</b>';
  const second = syncSentItemById('item-1', options);
  assert.equal((await second).ok, true);
  releaseFirst();
  assert.equal((await first).ok, true);
  assert.deepEqual(sent, ['<b>Latest</b>', '<b>First</b>', '<b>Latest</b>']);
});
