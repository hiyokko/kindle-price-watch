import assert from 'node:assert/strict';
import test from 'node:test';

import { compactCronRunResult } from '../src/cron-run-log.mjs';

test('cron logs keep run totals without dumping every checked book', () => {
  const summary = compactCronRunResult({
    checked: 3,
    remainingDue: 10,
    results: [
      { ok: true, notifications: [{ type: 'price_drop' }], book: { asin: 'B000000001' } },
      { ok: true, notifications: [], book: { asin: 'B000000002' } },
      {
        ok: false,
        error: 'timeout',
        notifications: [],
        book: { asin: 'B000000003', title: '失敗した本' }
      }
    ]
  });

  assert.equal('results' in summary, false);
  assert.deepEqual(summary.resultSummary, {
    total: 3,
    succeeded: 2,
    failed: 1,
    notifications: 1,
    failureSamples: [{ asin: 'B000000003', title: '失敗した本', error: 'timeout' }]
  });
});

test('compact cron logs retain phase timings and acquisition diagnostics', () => {
  const timings = { bookChecksMs: 1200, persistenceMs: 20, totalMs: 1250 };
  const priceAcquisition = { seriesFailureCacheSkips: 5, individualPriceHits: 10 };
  const summary = compactCronRunResult({ timings, priceAcquisition, results: [] });
  assert.deepEqual(summary.timings, timings);
  assert.deepEqual(summary.priceAcquisition, priceAcquisition);
});
