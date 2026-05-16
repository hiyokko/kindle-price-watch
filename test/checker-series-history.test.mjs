import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const checkerSource = fs.readFileSync(new URL('../src/checker.mjs', import.meta.url), 'utf8');

test('bulk checks forward deferred series notification options for history recording', () => {
  assert.match(
    checkerSource,
    /async function checkOneBookInStore[\s\S]+?applyCheckResultToStore\(store, bookRef, snapshotResult, now, checkResultApplyOptions\(options\)\)/
  );
  assert.match(
    checkerSource,
    /function checkResultApplyOptions[\s\S]+deferSeriesNotifications: options\.deferSeriesNotifications[\s\S]+seriesNotificationBaselines: options\.seriesNotificationBaselines[\s\S]+seriesFreshAfter: options\.seriesFreshAfter/
  );
});
