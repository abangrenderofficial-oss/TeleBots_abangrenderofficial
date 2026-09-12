import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_ITEMS_PER_INVOCATION,
  parseTelegramRetryAfterMs,
  shouldContinueInvocation,
  shouldKickNextWorker,
} from '../lib/bot/batch/send-policy.js';
import { claimNextOrderedBatchItem } from '../lib/bot/batch/ordered-claim.js';
import { copyWithTelegramRateLimitRetry } from '../lib/bot/batch/send-executor.js';

test('worker policy sends larger sequential chunks without unlimited invocation loops', () => {
  assert.equal(MAX_ITEMS_PER_INVOCATION, 12);
  assert.equal(shouldContinueInvocation({ processed: 0, startedAt: 1_000, now: 1_100 }), true);
  assert.equal(shouldContinueInvocation({ processed: 12, startedAt: 1_000, now: 1_100 }), false);
  assert.equal(shouldContinueInvocation({ processed: 1, startedAt: 1_000, now: 20_000 }), false);
});

test('Telegram explicit retry_after is recognized but unrelated failures are not blindly retried', () => {
  assert.equal(
    parseTelegramRetryAfterMs(new Error('Telegram copyMessage failed: Too Many Requests: retry after 7')),
    7_250,
  );
  assert.equal(parseTelegramRetryAfterMs(new Error('Bad Request: chat not found')), null);
  assert.equal(parseTelegramRetryAfterMs(new Error('fetch failed')), null);
});

test('rate-limit executor waits and retries the same item in place', async () => {
  const calls = [];
  const waits = [];
  const payload = { message_id: 17 };

  const result = await copyWithTelegramRateLimitRetry({
    payload,
    copy: async (received) => {
      calls.push(received.message_id);
      if (calls.length === 1) {
        throw new Error('Telegram copyMessage failed: Too Many Requests: retry after 2');
      }
      return { message_id: 501 };
    },
    sleepFn: async (ms) => {
      waits.push(ms);
    },
  });

  assert.deepEqual(calls, [17, 17]);
  assert.deepEqual(waits, [2_250]);
  assert.equal(result.message_id, 501);
});

test('rate-limit executor does not blindly retry ambiguous or permanent failures', async () => {
  let calls = 0;
  await assert.rejects(
    copyWithTelegramRateLimitRetry({
      payload: { message_id: 19 },
      copy: async () => {
        calls += 1;
        throw new Error('Bad Request: chat not found');
      },
      sleepFn: async () => {
        throw new Error('sleep should not run');
      },
    }),
    /chat not found/,
  );
  assert.equal(calls, 1);
});

test('duplicate worker does not fan out while another item is SENDING', () => {
  assert.equal(shouldKickNextWorker({ status: 'RUNNING', pending: 10, sending: 1 }), false);
  assert.equal(shouldKickNextWorker({ status: 'RUNNING', pending: 10, sending: 0 }), true);
  assert.equal(shouldKickNextWorker({ status: 'STOPPED', pending: 10, sending: 0 }), false);
  assert.equal(shouldKickNextWorker({ status: 'RUNNING', pending: 0, sending: 0 }), false);
});

test('ordered claim client uses the single atomic Supabase RPC', async () => {
  const oldFetch = globalThis.fetch;
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';

  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify([{ batch_id: 'B1', position: 0, item_id: 'I1', status: 'SENDING' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const row = await claimNextOrderedBatchItem('B1');
    assert.equal(row.position, 0);
    assert.equal(request.url, 'https://example.supabase.co/rest/v1/rpc/claim_send_batch_item_ordered');
    assert.deepEqual(JSON.parse(request.options.body), { p_batch_id: 'B1' });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl == null) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = oldUrl;
    if (oldKey == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
  }
});

test('ordered claim migration serializes by batch and blocks jumping past SENDING', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260912073000_ordered_batch_claim.sql', import.meta.url), 'utf8');
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /status in \('PENDING', 'SENDING'\)/);
  assert.match(sql, /order by position asc/);
  assert.match(sql, /v_row\.status <> 'PENDING'/);
});

test('worker uses ordered claims and tested rate-limit retry executor', async () => {
  const worker = await readFile(new URL('../api/telegram-sendall.js', import.meta.url), 'utf8');
  assert.match(worker, /claimNextOrderedBatchItem/);
  assert.doesNotMatch(worker, /claimNextBatchItem\(/);
  assert.match(worker, /copyWithTelegramRateLimitRetry/);
  assert.match(worker, /shouldKickNextWorker/);
});
