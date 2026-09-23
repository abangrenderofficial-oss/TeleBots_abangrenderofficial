import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isAiUnavailableError,
  titleNeedsTranslation,
} from '../lib/ai-gate.js';

test('titleNeedsTranslation spends AI only for non-Latin source titles', () => {
  assert.equal(titleNeedsTranslation({ title: 'Modern Lounge Chair', serial: null }), false);
  assert.equal(titleNeedsTranslation({ title: '520780.5705bb9bca62c\nModern Lounge Chair', serial: '520780.5705bb9bca62c' }), false);
  assert.equal(titleNeedsTranslation({ title: 'Современное кресло', serial: null }), true);
  assert.equal(titleNeedsTranslation({ title: '520780.5705bb9bca62c\nСовременное кресло', serial: '520780.5705bb9bca62c' }), true);
  assert.equal(titleNeedsTranslation({ title: '现代餐椅', serial: null }), true);
  assert.equal(titleNeedsTranslation({ title: '', serial: null }), false);
});

test('AI exhaustion errors are recognized centrally', () => {
  assert.equal(isAiUnavailableError(new Error('Translation unavailable: all providers failed')), true);
  assert.equal(isAiUnavailableError(new Error('Vision unavailable: quota exceeded')), true);
  assert.equal(isAiUnavailableError(new Error('Telegram edit failed')), false);
});

test('recaption source has explicit Continue Without AI flow and avoids unnecessary preview AI', async () => {
  const [gate, callback, media] = await Promise.all([
    readFile(new URL('../lib/ai-gate.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/bot/features/ai-limit-callback.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/bot/features/media.js', import.meta.url), 'utf8'),
  ]);

  assert.match(gate, /TERUSKAN TANPA AI/);
  assert.match(callback, /setRecaptionAiBypass\(sessionId, true\)/);
  assert.match(media, /titleNeedsTranslation\(currentProcessed\)/);
  assert.match(media, /isRecaptionAiBypass/);
});
