import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeWebhookUrls,
  normalizeWebhookEntries,
  parseWebhookUrls
} from '../src/webhook-config.mjs';

test('webhook configuration parsing deduplicates URLs and preserves paused entries', () => {
  const first = 'https://discord.com/api/webhooks/1/token';
  const second = 'https://discord.com/api/webhooks/2/token';
  assert.deepEqual(parseWebhookUrls(`${first}\n${first},${second}`), [first, second]);

  const entries = normalizeWebhookEntries([
    { name: 'main', url: first, enabled: true },
    { name: 'duplicate', url: first, enabled: false },
    { name: 'paused', url: second, enabled: false }
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(activeWebhookUrls(entries), [first]);
});
