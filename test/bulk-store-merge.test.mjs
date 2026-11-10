import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeBulkCheckStoreForPersist } from '../src/bulk-store-merge.mjs';

function baseStore() {
  return {
    version: 1, storeRevision: 10,
    settings: { notificationThreshold: 80 },
    books: [{ id: 'one', asin: 'B000000001', title: 'Book', currentPrice: 700, imageUrl: 'old-cover' }],
    priceHistory: [{ id: 'price-base', price: 700 }],
    seriesPriceHistory: [{ id: 'series-base', effectiveTotal: 700 }],
    notifications: [{ id: 'sent-base', status: 'sent', effectivePrice: 700 }],
    importQueue: { pending: [], completed: [], errors: [] }
  };
}

test('bulk merge preserves concurrent metadata, settings, books, and both price histories', () => {
  const base = baseStore();
  const current = structuredClone(base);
  const run = structuredClone(base);
  current.settings.notificationThreshold = 90;
  current.books[0].title = 'Edited title';
  current.books.push({ id: 'two', asin: 'B000000002', title: 'Concurrent book' });
  current.priceHistory.push({ id: 'price-current', price: 800 });
  current.seriesPriceHistory.push({ id: 'series-current', effectiveTotal: 800 });
  run.books[0].currentPrice = 500;
  run.priceHistory.push({ id: 'price-run', price: 500 });
  run.seriesPriceHistory.push({ id: 'series-run', effectiveTotal: 500 });
  const originals = structuredClone({ base, current, run });
  const merged = mergeBulkCheckStoreForPersist(current, run, base);
  assert.equal(merged.books[0].title, 'Edited title');
  assert.equal(merged.books[0].currentPrice, 500);
  assert.equal(merged.books.length, 2);
  assert.equal(merged.settings.notificationThreshold, 90);
  assert.equal(merged.priceHistory.length, 3);
  assert.equal(merged.seriesPriceHistory.length, 3);
  assert.deepEqual({ base, current, run }, originals);
});

test('bulk merge retains sent notifications and concurrent queue additions without duplicate IDs', () => {
  const base = baseStore();
  const current = structuredClone(base);
  const run = structuredClone(base);
  current.notifications.push({ id: 'sent-current', status: 'sent', scope: 'series' });
  run.notifications.push({ id: 'sent-run', status: 'sent', scope: 'series' });
  current.importQueue.pending.push({ key: 'asin:B000000002', input: 'B000000002' });
  run.importQueue.completed.push({ key: 'asin:B000000003', importedAt: '2026-11-10' });
  const merged = mergeBulkCheckStoreForPersist(current, run, base);
  assert.deepEqual(merged.notifications.map((entry) => entry.id), ['sent-base', 'sent-current', 'sent-run']);
  assert.equal(merged.notifications.every((entry) => entry.status === 'sent'), true);
  assert.equal(merged.importQueue.pending.length, 1);
  assert.equal(merged.importQueue.completed.length, 1);
});

test('bulk merge keeps the newest cursors across concurrent updates', () => {
  const base = baseStore();
  const current = { ...base, checkCursor: { lastBookId: 'newer', checkedAt: '2026-11-10T03:00:00Z' } };
  const run = { ...base, checkCursor: { lastBookId: 'older', checkedAt: '2026-11-10T02:00:00Z' } };
  const merged = mergeBulkCheckStoreForPersist(current, run, base);
  assert.equal(merged.checkCursor.lastBookId, 'newer');
});
