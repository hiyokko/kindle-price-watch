import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSeriesIdentityName,
  seriesCandidatesAreCompatible,
  seriesCandidatesHaveItemOverlap
} from '../src/series-identity.mjs';
import {
  auditStoreAgainstReference,
  restoreSeriesGroupsFromReference
} from '../src/store-reference-audit.mjs';

test('series candidates reject a larger unrelated series for the same source', () => {
  const husband = {
    seriesName: '弟の夫',
    items: [1, 2, 3, 4].map((volume) => ({ asin: `B00HUSBAN${volume}`, title: `弟の夫 ${volume}` }))
  };
  const slime = {
    seriesName: '転生したらスライムだった件～魔物の国の歩き方～',
    items: Array.from({ length: 8 }, (_, index) => ({
      asin: `B00SLIME0${index + 1}`,
      title: `転生したらスライムだった件～魔物の国の歩き方～ ${index + 1}`
    }))
  };

  assert.equal(seriesCandidatesHaveItemOverlap(husband, slime), false);
  assert.equal(seriesCandidatesAreCompatible(husband, slime), false);
});

test('series candidates accept child overlap or harmless imprint differences', () => {
  assert.equal(
    seriesCandidatesAreCompatible(
      { seriesName: '違国日記', items: [{ asin: 'B000000001' }] },
      { seriesName: '違国日記 (FEEL COMICS swing)', items: [{ asin: 'B000000002' }] }
    ),
    true
  );
  assert.equal(
    seriesCandidatesAreCompatible(
      { seriesName: 'Wet Moon', items: [{ asin: 'B000000003' }] },
      { seriesName: 'ウェットムーン', items: [{ asin: 'B000000003' }] }
    ),
    true
  );
  assert.equal(normalizeSeriesIdentityName('違国日記 (FEEL COMICS swing)'), '違国日記');
});

test('reference audit finds and repairs a source-bound series replacement in one mutation', () => {
  const seriesKey = 'series:asin:B074C7B1X1';
  const wrongBooks = Array.from({ length: 8 }, (_, index) => ({
    id: `wrong-${index + 1}`,
    asin: `B00SLIME0${index + 1}`,
    title: `転生したらスライムだった件～魔物の国の歩き方～ ${index + 1}`,
    seriesKey,
    seriesName: '転生したらスライムだった件～魔物の国の歩き方～',
    sourceUrl: 'https://www.amazon.co.jp/kindle-dbs/product/B074C7B1X1',
    importMode: 'kindle_series',
    volume: index + 1
  }));
  const referenceBooks = Array.from({ length: 4 }, (_, index) => ({
    id: `husband-${index + 1}`,
    asin: `B00HUSBAN${index + 1}`,
    title: `弟の夫 ${index + 1}`,
    seriesKey,
    seriesName: '弟の夫',
    sourceUrl: 'https://www.amazon.co.jp/dp/B074C7B1X1',
    importMode: 'kindle_series',
    volume: index + 1
  }));
  const store = {
    books: wrongBooks,
    priceHistory: [{ id: 'wrong-history', bookId: 'wrong-1', asin: wrongBooks[0].asin }],
    seriesPriceHistory: [{ id: 'wrong-series-history', seriesKey }],
    notifications: [{ id: 'wrong-notification', bookId: 'wrong-1', key: seriesKey }],
    checkCursor: { lastBookId: 'wrong-1', lastAsin: wrongBooks[0].asin, lastTitle: wrongBooks[0].title },
    seriesDiscoveryCursor: { lastSeriesKey: seriesKey, checkedAt: '2026-08-24T00:00:00.000Z' }
  };
  const reference = {
    books: referenceBooks,
    priceHistory: [{ id: 'husband-history', bookId: 'husband-1', asin: referenceBooks[0].asin }],
    seriesPriceHistory: [],
    notifications: []
  };

  const audit = auditStoreAgainstReference(store, reference);
  assert.equal(audit.seriesIdentityFindings.length, 1);
  assert.equal(audit.seriesIdentityFindings[0].referenceSeriesName, '弟の夫');
  assert.equal(audit.titleChanges.length, 0);

  const repair = restoreSeriesGroupsFromReference(store, reference, [seriesKey], {
    now: '2026-08-29T10:00:00.000Z'
  });
  assert.equal(repair.repairedSeries, 1);
  assert.deepEqual(store.books.map((book) => book.seriesName), ['弟の夫', '弟の夫', '弟の夫', '弟の夫']);
  assert.equal(store.priceHistory.some((entry) => entry.id === 'wrong-history'), false);
  assert.equal(store.priceHistory.some((entry) => entry.id === 'husband-history'), true);
  assert.equal(store.seriesPriceHistory.length, 0);
  assert.equal(store.notifications.length, 0);
  assert.equal(store.checkCursor.lastBookId, '');
  assert.equal(store.seriesDiscoveryCursor.lastSeriesKey, seriesKey);
});

test('reference audit treats an expanded omnibus title as the same book title', () => {
  const asin = 'B00QAEZKNC';
  const audit = auditStoreAgainstReference(
    {
      books: [{
        id: 'current',
        asin,
        title: '極厚版『軍鶏』 巻之壱 （１～３巻相当） (イブニングコミックス)',
        seriesName: '軍鶏'
      }]
    },
    {
      books: [{
        id: 'reference',
        asin,
        title: '極厚版 軍鶏 ３',
        seriesName: '極厚版 軍鶏'
      }]
    }
  );

  assert.equal(audit.titleChanges.length, 0);
});
