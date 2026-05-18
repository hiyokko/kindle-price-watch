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

test('deferred series notifications skip scopes that were removed during the run', () => {
  assert.match(
    checkerSource,
    /function captureSeriesNotificationBaseline[\s\S]+if \(!isActiveSeriesAggregateSnapshot\(baseline\)\) return null/
  );
  assert.match(
    checkerSource,
    /async function sendDeferredSeriesNotifications[\s\S]+if \(!isActiveSeriesAggregateSnapshot\(baseline\)\) continue[\s\S]+if \(!isActiveSeriesAggregateSnapshot\(after\)\) continue/
  );
});

test('book listing adds observed discount references without overwriting list price', () => {
  assert.match(
    checkerSource,
    /const discountReferences = observedDiscountReferenceSummaries\(store\)[\s\S]+publicBookWithSeriesHistory\(book, seriesHistory, discountReferences\)/
  );
  assert.match(
    checkerSource,
    /function publicBookWithObservedDiscountReference[\s\S]+if \(result\.listPrice != null\) return result[\s\S]+discountReferencePrice: reference\.price/
  );
});
