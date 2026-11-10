import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPlanPreview, planDueChecks } from '../src/check-planner.mjs';

const now = Date.parse('2026-11-10T03:00:00Z');
const hour = 60 * 60 * 1000;
const date = (hours) => new Date(now - hours * hour).toISOString();

function book(id, hours, extra = {}) {
  return {
    id, asin: `B${id.padStart(9, '0')}`, title: id,
    lastCheckedAt: date(hours), createdAt: date(240),
    currentPrice: 700, effectivePrice: 693,
    provider: 'amazon_html', imageUrl: 'https://example.com/cover.jpg',
    ...extra
  };
}

function plan(books, options = {}) {
  return planDueChecks({ books }, { batchSize: 3 }, now, { overdueHours: 48, ...options });
}

test('overdue singles precede discounted series and new releases, oldest first', () => {
  const books = [
    book('sale', 72, { currentPrice: 100, effectivePrice: 99, listPrice: 700, seriesKey: 'sale' }),
    book('new', 0, { lastCheckedAt: null, createdAt: date(1), currentPrice: null, effectivePrice: null }),
    book('oldest', 120),
    book('older', 96)
  ];
  const before = structuredClone(books);
  const result = plan(books);
  assert.deepEqual(result.books.map((entry) => entry.id), ['oldest', 'older', 'sale']);
  assert.equal(result.summary.overdueCandidates, 3);
  assert.equal(result.summary.overdueSelected, 3);
  assert.deepEqual(books, before);
});

test('series completion cannot insert fresher siblings into the oldest prefix', () => {
  const result = plan([
    book('series-old', 120, { seriesKey: 'series-1' }),
    book('series-tail', 60, { seriesKey: 'series-1' }),
    book('single', 96),
    book('other-single', 72)
  ]);
  assert.deepEqual(result.books.map((entry) => entry.id), ['series-old', 'single', 'other-single']);
});

test('recent new releases retain their priority after the overdue prefix', () => {
  const result = plan([
    book('regular', 24),
    book('new', 0, { lastCheckedAt: null, createdAt: date(1), currentPrice: null, effectivePrice: null }),
    book('old', 120)
  ]);
  assert.deepEqual(result.books.map((entry) => entry.id), ['old', 'new', 'regular']);
});

test('overdue boundary is inclusive and unknown timestamps remain eligible', () => {
  const result = plan([book('recent', 47.9), book('boundary', 48), book('unknown', 0, {
    lastCheckedAt: 'invalid', createdAt: '', updatedAt: ''
  })]);
  assert.deepEqual([...result.overdueBookIds], ['unknown', 'boundary']);
  assert.equal(result.summary.oldestPendingAt, '1970-01-01T00:00:00.000Z');
});

test('retry cooldown remains effective, while force-all keeps its explicit override', () => {
  const cooling = book('blocked', 1, { lastError: 'HTTP 503', imageUrl: '' });
  assert.equal(plan([cooling]).books.length, 0);
  assert.deepEqual(plan([cooling], { forceAll: true }).books.map((entry) => entry.id), ['blocked']);
});

test('cursor rotation breaks equal-age ties and force-all still respects the oldest prefix', () => {
  const books = [book('one', 120), book('two', 120), book('sale', 24, {
    currentPrice: 100, effectivePrice: 99, listPrice: 700
  })];
  const result = planDueChecks({ books, checkCursor: { lastBookId: 'one' } }, { batchSize: 2 }, now, {
    forceAll: true, overdueHours: 48
  });
  assert.deepEqual(result.books.map((entry) => entry.id), ['two', 'one']);
  assert.equal(result.dueSelected, 2);
});

test('repeated batches drain old books despite a continuous supply of fresh priority books', () => {
  const books = Array.from({ length: 6 }, (_, index) => book(`old-${index}`, 120 - index));
  const checked = new Set();
  for (let round = 0; round < 3; round++) {
    books.push(book(`new-${round}`, 0, { lastCheckedAt: null, createdAt: date(1), currentPrice: null }));
    const result = planDueChecks({ books }, { batchSize: 2 }, now, { overdueHours: 48 });
    for (const candidate of result.books) {
      checked.add(candidate.id);
      candidate.lastCheckedAt = new Date(now).toISOString();
    }
  }
  assert.equal([...checked].filter((id) => id.startsWith('old-')).length, 6);
});

test('plan previews are bounded and preserve the store and notification state', () => {
  const store = {
    books: Array.from({ length: 30 }, (_, index) => book(String(index), 120 - index)),
    notifications: [{ id: 'notification', status: 'sent' }],
    priceHistory: [{ id: 'history', price: 700 }]
  };
  const before = structuredClone(store);
  const preview = checkPlanPreview(store, { batchSize: 25 }, now);
  assert.equal(preview.nextBooks.length, 20);
  assert.equal(preview.planned, 25);
  assert.equal(preview.overdueSelected, 25);
  assert.deepEqual(store, before);
});
