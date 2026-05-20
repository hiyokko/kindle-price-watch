import assert from 'node:assert/strict';
import test from 'node:test';
import { sendDiscordNotification } from '../src/notifier.mjs';

test('sendDiscordNotification retries Discord 429 using retry_after', async () => {
  const waits = [];
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.3 }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(null, { status: 204 });
  };

  try {
    const result = await sendDiscordNotification({ content: 'test' }, {
      webhookUrls: ['https://discord.com/api/webhooks/1/token'],
      retryAttempts: 1,
      retrySafetyMs: 0,
      webhookSpacingMs: 0,
      sleep: async (ms) => waits.push(ms)
    });

    assert.equal(calls, 2);
    assert.deepEqual(waits, [300]);
    assert.equal(result.ok, true);
    assert.equal(result.delivered, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.retries, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendDiscordNotification reports Discord 429 after retries are exhausted', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.1 }), {
      status: 429,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    await assert.rejects(
      sendDiscordNotification({ content: 'test' }, {
        webhookUrls: ['https://discord.com/api/webhooks/1/token'],
        retryAttempts: 1,
        retrySafetyMs: 0,
        webhookSpacingMs: 0,
        sleep: async () => {}
      }),
      /Discord HTTP 429/
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
