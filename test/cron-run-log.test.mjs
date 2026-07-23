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
