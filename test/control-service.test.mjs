import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bookImportQueueKey,
  mergedRuntimeSettings,
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
    notificationThreshold: 10,
    batchSize: 50,
    listPriceChallengeBatchSize: 50,
    notifyOnPriceDrop: true,
    notifyOnBestEver: true
  });
  assert.equal(mergedRuntimeSettings({ notificationThreshold: 120 }).notificationThreshold, 95);
  assert.equal(mergedRuntimeSettings({ batchSize: 0 }).batchSize, 1);
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
