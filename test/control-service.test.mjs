import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  bookImportQueueKey,
  mergedRuntimeSettings,
  NOTIFICATION_THRESHOLD_OPTIONS,
  parseBookImportInputs,
  publicBookImportQueue
} from '../src/control-service.mjs';

test('book import parsing handles JSON, comments, and canonical ASIN keys', () => {
  assert.deepEqual(parseBookImportInputs('B000000001\n# comment\n\"B000000002\"'), [
    'B000000001',
    'B000000002'
  ]);
  assert.deepEqual(parseBookImportInputs('["B000000001", "B000000002"]'), [
    'B000000001',
    'B000000002'
  ]);
  assert.equal(bookImportQueueKey('https://www.amazon.co.jp/dp/B000000001'), 'asin:B000000001');
});

test('runtime settings preserve defaults and clamp persisted values', () => {
  assert.deepEqual(mergedRuntimeSettings({}), {
    notificationThreshold: 80,
    batchSize: 50,
    listPriceChallengeBatchSize: 50,
    notifyOnPriceDrop: true,
    notifyOnBestEver: true
  });
  assert.equal(mergedRuntimeSettings({ notificationThreshold: 5 }).notificationThreshold, 10);
  assert.equal(mergedRuntimeSettings({ notificationThreshold: 95 }).notificationThreshold, 90);
  assert.equal(mergedRuntimeSettings({ notificationThreshold: 50 }).notificationThreshold, 50);
  assert.equal(mergedRuntimeSettings({ batchSize: 0 }).batchSize, 1);
});

test('notification threshold selector matches the supported settings', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const select = html.match(/<select id="thresholdInput"[\s\S]*?<\/select>/)?.[0] || '';
  const values = [...select.matchAll(/<option value="(\d+)"/g)].map((match) => Number(match[1]));

  assert.deepEqual(values, NOTIFICATION_THRESHOLD_OPTIONS);
  assert.equal(values.includes(5), false);
  assert.deepEqual(values.filter((value) => value >= 60), [60, 70, 80, 90]);
});

test('public import queue exposes bounded summary fields', () => {
  const payload = publicBookImportQueue({
    pending: [{ key: 'asin:B000000001', input: 'B000000001', addedAt: '2026-07-24' }],
    completed: [{ key: 'asin:B000000002', input: 'B000000002', imported: 1 }],
    errors: [{ key: 'asin:B000000003', input: 'B000000003', error: 'timeout' }]
  });

  assert.deepEqual(payload.summary, {
    pendingCount: 1,
    completedCount: 1,
    errorCount: 1
  });
  assert.equal(payload.completed[0].imported, 1);
});
