import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('manual stop and resume use the unified processing gate', async () => {
  const [stop, resume, batchControl] = await Promise.all([
    source('lib/bot/commands/stop.js'),
    source('lib/bot/commands/resume.js'),
    source('lib/bot/batch/control.js'),
  ]);

  assert.match(stop, /pausePipeline/);
  assert.match(stop, /MANUAL_STOP/);
  assert.match(stop, /setRecaptionSessionStatus\(session\.id, 'PAUSED'\)/);
  assert.match(resume, /getPipelineState/);
  assert.match(resume, /AI_LIMIT/);
  assert.match(resume, /kickImmediateMediaWorker/);
  assert.match(resume, /kickRecaptionWorker/);
  assert.match(batchControl, /getPipelineState/);
  assert.match(batchControl, /AI wait masih aktif/);
});

test('new format is a durable master-pipeline boundary', async () => {
  const [gate, runner, preview] = await Promise.all([
    source('lib/bot/features/format-gate.js'),
    source('lib/bot/features/recaption-runner.js'),
    source('lib/bot/features/preview-ui.js'),
  ]);

  assert.match(gate, /PIPELINE_REASONS\.NEW_FORMAT/);
  assert.match(gate, /pausePipeline/);
  assert.match(runner, /getPipelineState/);
  assert.match(runner, /pipeline_wait/);
  assert.match(preview, /allowedFormatPreview/);
  assert.match(preview, /pipeline\.reason === PIPELINE_REASONS\.NEW_FORMAT/);
});

test('direct queue keeps ten prep workers behind one revision-safe sender', async () => {
  const worker = await source('lib/bot/features/immediate-media-worker.js');

  assert.match(worker, /IMMEDIATE_MEDIA_CONCURRENCY = 10/);
  assert.match(worker, /IMMEDIATE_MEDIA_SENDER_CONCURRENCY = 1/);
  assert.match(worker, /preparedProfileRevisionIsCurrent/);
  assert.match(worker, /claim_queue_preview_send/);
  assert.match(worker, /gateAfterClaim/);
  assert.match(worker, /AI_LIMIT/);
  assert.match(worker, /ai_continue_direct:/);
  assert.match(worker, /allowAiBypass/);
});

test('format edits invalidate prepared items and in-flight prep keeps its start revision', async () => {
  const [callbacks, stateInput, controller] = await Promise.all([
    source('lib/bot/features/preview-callbacks.js'),
    source('lib/bot/features/state-input.js'),
    source('lib/bot/features/pipeline-controller.js'),
  ]);

  assert.match(callbacks, /markFormatProfileChanged/);
  assert.match(stateInput, /markFormatProfileChanged/);
  assert.match(controller, /format_profile_revision_v1:/);
  assert.match(controller, /invalidatePreparedItemsForProfile/);
  assert.match(controller, /immediate_prep_revision_v1:/);
  assert.match(controller, /immediate_prepared_revision_v1:/);
  assert.match(controller, /snapshot the profile revision at prep START/i);
  assert.match(controller, /snapshotRevision/);
});

test('direct AI continue is scoped to only the blocked item', async () => {
  const [callback, recaption] = await Promise.all([
    source('lib/bot/features/ai-limit-callback.js'),
    source('lib/bot/features/recaption.js'),
  ]);

  assert.match(callback, /ai_continue_direct:/);
  assert.match(callback, /setDirectAiBypass/);
  assert.match(callback, /allowedReasons: \[PIPELINE_REASONS\.AI_LIMIT\]/);
  assert.match(recaption, /options\.aiBypass/);
});
