import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canUseCachedSeriesPriceSnapshotForBook,
  canonicalSeriesSourceAsin,
  needsDiscountExpiryRecheck,
  isActiveSeriesAggregateSnapshot,
  isFutureReleaseDate,
  isSupplementalSeriesBookTitle,
  isUsableIncompleteSeriesCandidate,
  isWeakSeriesImageUrl,
  priceIntegrityIssueForBook,
  repairStorePriceState,
  selectListPriceChallengeCandidates,
  seriesKeyForSeries,
  seriesSourceUrlFor,
  seriesAggregateSnapshot,
  seriesSnapshotFromKindleSeriesForBook,
  shouldRecheckCompletedSeriesGroup,
  snapshotInputUrlForBook,
  summarizeCheckResultErrors,
  suspiciousSnapshotReason,
  suspiciousPriceReason,
  validateListPriceChallengeCandidate
} from '../src/checker.mjs';

test('price validation rejects tiny Amazon HTML prices without a prior reference', () => {
  assert.match(
    suspiciousPriceReason({
      price: 1,
      points: 1,
      effectivePrice: 0,
      provider: 'amazon_html'
    }),
    /不自然に小さすぎます/
  );

  assert.match(
    suspiciousPriceReason({
      price: 7,
      points: 0,
      effectivePrice: 7,
      provider: 'amazon_html'
    }),
    /不自然に小さすぎます/
  );
});

test('price validation still accepts explicit low Kindle sale prices above the contamination floor', () => {
  assert.equal(
    suspiciousPriceReason({
      price: 33,
      points: 30,
      effectivePrice: 3,
      provider: 'amazon_html'
    }),
    ''
  );
});

test('price validation accepts explicitly displayed tiny Kindle yen prices', () => {
  assert.equal(
    suspiciousPriceReason({
      price: 2,
      points: 0,
      effectivePrice: 2,
      provider: 'amazon_html',
      explicitPriceDisplay: true
    }),
    ''
  );
});

test('price validation accepts explicitly free Kindle prices', () => {
  assert.equal(
    suspiciousPriceReason({
      price: 0,
      points: 0,
      effectivePrice: 0,
      provider: 'amazon_html',
      explicitFreeKindlePrice: true
    }),
    ''
  );
});

test('future release dates are evaluated in JST', () => {
  assert.equal(isFutureReleaseDate('2026-06-04', '2026-05-13T00:00:00+09:00'), true);
  assert.equal(isFutureReleaseDate('2026-05-13', '2026-05-13T00:00:00+09:00'), false);
  assert.equal(isFutureReleaseDate('2026-05-12', '2026-05-13T00:00:00+09:00'), false);
});

test('snapshot validation does not reject explicit Amazon HTML prices against stale stored list price', () => {
  assert.equal(
    suspiciousSnapshotReason(
      {
        listPrice: 572,
        currentPrice: 330,
        effectivePrice: 213
      },
      {
        currentPrice: 660,
        currentPoints: 117,
        effectivePrice: 543,
        listPrice: null,
        provider: 'amazon_html',
        explicitPriceDisplay: true
      }
    ),
    ''
  );
});

test('snapshot validation does not reject series prices against stale stored list price', () => {
  assert.equal(
    suspiciousSnapshotReason(
      {
        listPrice: 572,
        currentPrice: 330,
        effectivePrice: 213
      },
      {
        currentPrice: 660,
        currentPoints: 117,
        effectivePrice: 543,
        listPrice: null,
        provider: 'amazon_series_child'
      }
    ),
    ''
  );
});

test('series aggregate snapshot treats removed series scopes as inactive', () => {
  const snapshot = seriesAggregateSnapshot(
    {
      books: [],
      seriesPriceHistory: []
    },
    {
      key: 'series:asin:B0F7T7ZR2Q',
      seriesKey: 'series:asin:B0F7T7ZR2Q',
      sourceUrl: 'https://www.amazon.co.jp/kindle-dbs/product/B0F7T7ZR2Q'
    },
    { freshAfter: '2026-05-18T00:00:00.000Z' }
  );

  assert.equal(snapshot.bookCount, 0);
  assert.equal(snapshot.representativeBook, null);
  assert.equal(snapshot.observedFrom, '');
  assert.equal(snapshot.observedTo, '');
  assert.equal(snapshot.currentPointsTotal, null);
  assert.equal(isActiveSeriesAggregateSnapshot(snapshot), false);
});

test('snapshot validation keeps trusted series bulk prices over weak single-page HTML prices', () => {
  assert.match(
    suspiciousSnapshotReason(
      {
        currentPrice: 891,
        effectivePrice: 891,
        provider: 'amazon_series_bulk'
      },
      {
        currentPrice: 6,
        currentPoints: 0,
        effectivePrice: 6,
        provider: 'amazon_html',
        explicitPriceDisplay: false
      }
    ),
    /シリーズ一括取得済み価格/
  );

  assert.equal(
    suspiciousSnapshotReason(
      {
        currentPrice: 891,
        effectivePrice: 891,
        provider: 'amazon_series_bulk'
      },
      {
        currentPrice: 33,
        currentPoints: 0,
        effectivePrice: 33,
        provider: 'amazon_html',
        explicitPriceDisplay: true
      }
    ),
    ''
  );
});

test('price validation rejects steep uncorroborated Amazon reader prices', () => {
  assert.match(
    suspiciousPriceReason({
      price: 200,
      points: 2,
      effectivePrice: 198,
      provider: 'amazon_reader',
      referencePrices: [440]
    }),
    /reader価格/
  );

  assert.equal(
    suspiciousPriceReason({
      price: 396,
      points: 4,
      effectivePrice: 392,
      provider: 'amazon_reader',
      referencePrices: [440]
    }),
    ''
  );
});

test('single-book fallback uses the individual product URL before the series URL', () => {
  assert.equal(
    snapshotInputUrlForBook({
      asin: 'B00E3RA01K',
      amazonUrl: 'https://www.amazon.co.jp/gp/product/B00E3RA01K?binding=kindle_edition&ref=dbs_dp_rwt_sb_pc_tkin',
      sourceUrl: 'https://www.amazon.co.jp/dp/B074CK141Z'
    }),
    'https://www.amazon.co.jp/gp/product/B00E3RA01K?binding=kindle_edition&ref=dbs_dp_rwt_sb_pc_tkin'
  );

  assert.equal(
    snapshotInputUrlForBook({
      asin: 'B00E3RA01K',
      amazonUrl: 'https://www.amazon.co.jp/dp/B074CK141Z',
      sourceUrl: 'https://www.amazon.co.jp/dp/B074CK141Z'
    }),
    ''
  );
});

test('price integrity audit flags suspicious checked prices', () => {
  const book = {
    id: 'book-1',
    asin: 'B00TEST001',
    title: '監査テスト 1',
    currentPrice: 2,
    currentPoints: 0,
    effectivePrice: 2,
    listPrice: 440,
    provider: 'amazon_html'
  };

  const issue = priceIntegrityIssueForBook(book, { books: [book] });
  assert.equal(issue.severity, 'suspicious');
  assert.match(issue.reason, /小さすぎます/);
});

test('price integrity audit warns on low-confidence series outliers', () => {
  const store = {
    books: [
      {
        id: 'book-1',
        asin: 'B00TEST001',
        title: '監査シリーズ 1',
        seriesKey: 'series:asin:B00SERIES1',
        currentPrice: 200,
        currentPoints: 0,
        effectivePrice: 200,
        provider: 'listasin'
      },
      ...[2, 3, 4].map((volume) => ({
        id: `book-${volume}`,
        asin: `B00TEST00${volume}`,
        title: `監査シリーズ ${volume}`,
        seriesKey: 'series:asin:B00SERIES1',
        currentPrice: 396,
        currentPoints: 4,
        effectivePrice: 392,
        provider: 'amazon_series_child'
      }))
    ]
  };

  const issue = priceIntegrityIssueForBook(store.books[0], store);
  assert.equal(issue.severity, 'warning');
  assert.match(issue.reason, /シリーズ中央値/);
});

test('price integrity audit trusts plausible Amazon HTML sale prices', () => {
  const store = {
    books: [
      {
        id: 'book-1',
        asin: 'B00TEST001',
        title: '通常セール 1',
        seriesKey: 'series:asin:B00SERIES1',
        currentPrice: 110,
        currentPoints: 1,
        effectivePrice: 109,
        provider: 'amazon_html'
      },
      ...[2, 3, 4].map((volume) => ({
        id: `book-${volume}`,
        asin: `B00TEST00${volume}`,
        title: `通常セール ${volume}`,
        seriesKey: 'series:asin:B00SERIES1',
        currentPrice: 396,
        currentPoints: 4,
        effectivePrice: 392,
        provider: 'amazon_series_child'
      }))
    ]
  };

  assert.equal(priceIntegrityIssueForBook(store.books[0], store), null);
});

test('check result error summary groups transient failures', () => {
  const summary = summarizeCheckResultErrors([
    {
      ok: false,
      error: '価格を取得できませんでした',
      book: { asin: 'B00TEST001', title: '取得失敗 1' }
    },
    {
      ok: false,
      error: 'HTTP 503',
      book: { asin: 'B00TEST002', title: '取得失敗 2' }
    },
    {
      ok: true,
      book: { asin: 'B00TEST003', title: '成功' }
    }
  ]);

  assert.equal(summary.total, 2);
  assert.deepEqual(
    summary.breakdown.map((entry) => [entry.reason, entry.count]),
    [
      ['Amazonブロック/HTTP制限', 1],
      ['価格を取得できませんでした', 1]
    ]
  );
  assert.equal(summary.samples.length, 2);
});

test('store repair defers nonfatal series discovery source errors for complete known coverage', () => {
  const store = {
    books: [1, 2, 3].map((volume) => ({
      id: `series-${volume}`,
      asin: `B00SERIES${volume}`,
      title: `保留シリーズ ${volume}`,
      seriesName: '保留シリーズ',
      seriesKey: 'series:asin:B00SERIES1',
      sourceUrl: 'https://www.amazon.co.jp/dp/B00SERIES1',
      importMode: 'kindle_series',
      seriesExpectedCount: 3,
      volume,
      currentPrice: 396,
      currentPoints: 0,
      effectivePrice: 396,
      provider: 'amazon_series_bulk',
      seriesDiscoveryStatus: 'error',
      seriesDiscoveryError: 'シリーズ内のKindle ASINを取得できませんでした'
    })),
    priceHistory: [],
    notifications: [],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-12T03:00:00.000Z'
  });

  assert.equal(summary.seriesDiscoveryDeferred, 1);
  assert.equal(store.books.every((book) => book.seriesDiscoveryStatus === 'deferred'), true);
  assert.equal(store.books.every((book) => book.seriesDiscoveryError === ''), true);
});

test('series snapshots prefer validated series page prices for checked series books', () => {
  const snapshot = seriesSnapshotFromKindleSeriesForBook({
    items: [
      {
        asin: 'B085VPHHNK',
        title: 'バトルスタディーズ（２２）',
        imageUrl: 'https://m.media-amazon.com/images/I/sample.jpg',
        amazonUrl: 'https://www.amazon.co.jp/dp/B085VPHHNK',
        currentPrice: 792,
        currentPoints: 113,
        effectivePrice: 679,
        provider: 'amazon_series_child'
      }
    ]
  }, 'B085VPHHNK', {
    title: 'old',
    provider: 'amazon_html'
  });

  assert.equal(snapshot.currentPrice, 792);
  assert.equal(snapshot.currentPoints, 113);
  assert.equal(snapshot.effectivePrice, 679);
  assert.equal(snapshot.provider, 'amazon_series_child');
});

test('series snapshots do not reuse stale stored list prices for discounts', () => {
  const snapshot = seriesSnapshotFromKindleSeriesForBook({
    items: [
      {
        asin: 'B0B6FJ8589',
        currentPrice: 594,
        currentPoints: 0,
        effectivePrice: 594,
        provider: 'amazon_series_bulk'
      }
    ]
  }, 'B0B6FJ8589', {
    title: '天幕のジャードゥーガル 1',
    listPrice: 2376,
    provider: 'amazon_series_bulk'
  });

  assert.equal(snapshot.currentPrice, 594);
  assert.equal(snapshot.listPrice, null);
});

test('store repair clears stale series-derived aggregate list prices after later single-page checks', () => {
  const store = {
    books: [
      {
        id: 'book-1',
        asin: 'B0DGL9JJMJ',
        title: '国宝 １',
        currentPrice: 759,
        currentPoints: 28,
        effectivePrice: 731,
        listPrice: 2310,
        provider: 'amazon_html',
        lowestPrice: 759,
        lowestEffectivePrice: 731
      },
      {
        id: 'book-2',
        asin: 'B0CURATED1',
        title: '履歴だけに定価が残ったシリーズ本',
        currentPrice: 396,
        currentPoints: 0,
        effectivePrice: 396,
        provider: 'curated_series',
        lowestPrice: 396,
        lowestEffectivePrice: 396
      }
    ],
    priceHistory: [
      {
        bookId: 'book-1',
        asin: 'B0DGL9JJMJ',
        price: 759,
        points: 0,
        effectivePrice: 759,
        listPrice: 2310,
        provider: 'amazon_series_bulk',
        checkedAt: '2026-05-11T17:11:10.480Z'
      },
      {
        bookId: 'book-1',
        asin: 'B0DGL9JJMJ',
        price: 759,
        points: 28,
        effectivePrice: 731,
        listPrice: 2310,
        provider: 'amazon_html',
        checkedAt: '2026-05-11T22:49:29.824Z'
      },
      {
        bookId: 'book-2',
        asin: 'B0CURATED1',
        price: 396,
        points: 0,
        effectivePrice: 396,
        listPrice: 396,
        provider: 'curated_series',
        checkedAt: '2026-05-06T19:28:04.417Z'
      }
    ],
    notifications: [],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-12T01:00:00.000Z'
  });

  assert.equal(summary.changed, true);
  assert.equal(store.books[0].currentPrice, 759);
  assert.equal(store.books[0].listPrice, null);
  assert.equal(store.priceHistory.every((entry) => entry.listPrice == null), true);
});

test('store repair canonicalizes series bulk titles and fixes duplicated sequential volumes', () => {
  const store = {
    books: [1, 2, 1, 4, 5].map((volume, index) => ({
      id: `attack-${index + 1}`,
      asin: `B00ATTACK${index + 1}`,
      title: '進撃の巨人 １',
      seriesName: '進撃の巨人',
      seriesKey: 'series:asin:B009KYC6S6',
      seriesExpectedCount: 5,
      importMode: 'kindle_series',
      volume,
      currentPrice: 594,
      currentPoints: 0,
      effectivePrice: 594,
      provider: 'amazon_series_bulk'
    })),
    priceHistory: [],
    notifications: [],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-12T02:30:00.000Z'
  });

  assert.equal(summary.changed, true);
  assert.deepEqual(store.books.map((book) => book.volume), [1, 2, 3, 4, 5]);
  assert.deepEqual(store.books.map((book) => book.title), [
    '進撃の巨人 １',
    '進撃の巨人 ２',
    '進撃の巨人 ３',
    '進撃の巨人 ４',
    '進撃の巨人 ５'
  ]);
});

test('Kindle DBS product input keeps the collection ASIN as the series identity', () => {
  const input = 'https://www.amazon.co.jp/kindle-dbs/product/B0FFTJ4W95';
  const series = {
    sourceAsin: 'B08GC7TB1F',
    items: [
      { asin: 'B08GC7TB1F', title: '王様ランキング(1) (BLIC)', volume: 1 },
      { asin: 'B08GCBG5QB', title: '王様ランキング(2) (BLIC)', volume: 2 }
    ]
  };

  assert.equal(canonicalSeriesSourceAsin(input, series), 'B0FFTJ4W95');
  assert.equal(seriesKeyForSeries(input, series), 'series:asin:B0FFTJ4W95');
  assert.equal(seriesSourceUrlFor(input, series), 'https://www.amazon.co.jp/kindle-dbs/product/B0FFTJ4W95');
});

test('store repair removes Amazon reader series navigation pseudo items', () => {
  const store = {
    books: [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `hajime-${index + 1}`,
        asin: `B00HAJIME${index + 1}`,
        title: `はじめアルゴリズム ${index + 1}`,
        seriesName: 'はじめアルゴリズム',
        seriesKey: 'series:asin:B077G1LLT2',
        seriesExpectedCount: 11,
        importMode: 'kindle_series',
        volume: index + 1,
        currentPrice: 759,
        currentPoints: 0,
        effectivePrice: 759
      })),
      {
        id: 'hajime-pseudo',
        asin: 'B07BHYVPPL',
        title: '全10巻中第1巻: はじめアルゴリズム',
        seriesName: 'はじめアルゴリズム',
        seriesKey: 'series:asin:B077G1LLT2',
        seriesExpectedCount: 11,
        importMode: 'kindle_series',
        volume: 11,
        currentPrice: null,
        currentPoints: 0,
        effectivePrice: null
      }
    ],
    priceHistory: [
      { id: 'history-pseudo', bookId: 'hajime-pseudo', asin: 'B07BHYVPPL', checkedAt: '2026-05-20T00:00:00.000Z' }
    ],
    notifications: [
      { id: 'notification-pseudo', bookId: 'hajime-pseudo', asin: 'B07BHYVPPL', status: 'pending' }
    ],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-21T01:00:00.000Z'
  });

  assert.equal(summary.changed, true);
  assert.equal(summary.removedSeriesNavigationItems, 1);
  assert.equal(summary.removedHistory, 1);
  assert.equal(summary.removedNotifications, 1);
  assert.equal(store.books.length, 10);
  assert.equal(store.books.some((book) => book.asin === 'B07BHYVPPL'), false);
  assert.deepEqual([...new Set(store.books.map((book) => book.seriesExpectedCount))], [10]);
  assert.deepEqual(store.books.map((book) => book.volume), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('store repair removes supplemental books mixed into main series volumes', () => {
  const store = {
    books: [
      ...Array.from({ length: 34 }, (_, index) => ({
        id: `aot-${index + 1}`,
        asin: `B00AOT${String(index + 1).padStart(4, '0')}`,
        title: `進撃の巨人 ${index + 1}`,
        seriesName: '進撃の巨人',
        seriesKey: 'series:asin:B009KYC6S6',
        seriesExpectedCount: 36,
        importMode: 'kindle_series',
        volume: index + 1,
        currentPrice: 550,
        currentPoints: 0,
        effectivePrice: 550
      })),
      {
        id: 'aot-lost-girls',
        asin: 'B01DLJNQK2',
        title: '進撃の巨人 ＬＯＳＴ ＧＩＲＬＳ（１） (週刊少年マガジンコミックス)',
        seriesName: '進撃の巨人',
        seriesKey: 'series:asin:B009KYC6S6',
        seriesExpectedCount: 36,
        importMode: 'kindle_series',
        volume: 35,
        currentPrice: 770,
        currentPoints: 0,
        effectivePrice: 770
      },
      {
        id: 'aot-answers',
        asin: 'B07HNXWX2Y',
        title: '進撃の巨人 ＡＮＳＷＥＲＳ（１） (週刊少年マガジンコミックス)',
        seriesName: '進撃の巨人',
        seriesKey: 'series:asin:B009KYC6S6',
        seriesExpectedCount: 36,
        importMode: 'kindle_series',
        volume: 36,
        currentPrice: 770,
        currentPoints: 0,
        effectivePrice: 770
      },
      {
        id: 'kamui-gaiden-1',
        asin: 'B00KAMUI01',
        title: 'カムイ伝全集 カムイ外伝 １',
        seriesName: 'カムイ伝全集 カムイ外伝',
        seriesKey: 'series:asin:B00KAMUI00',
        seriesExpectedCount: 2,
        importMode: 'kindle_series',
        volume: 1,
        currentPrice: 660,
        currentPoints: 0,
        effectivePrice: 660
      },
      {
        id: 'kamui-gaiden-2',
        asin: 'B00KAMUI02',
        title: 'カムイ伝全集 カムイ外伝 ２',
        seriesName: 'カムイ伝全集 カムイ外伝',
        seriesKey: 'series:asin:B00KAMUI00',
        seriesExpectedCount: 2,
        importMode: 'kindle_series',
        volume: 2,
        currentPrice: 660,
        currentPoints: 0,
        effectivePrice: 660
      }
    ],
    priceHistory: [
      { id: 'history-lost-girls', bookId: 'aot-lost-girls', asin: 'B01DLJNQK2', checkedAt: '2026-05-20T00:00:00.000Z' }
    ],
    notifications: [
      { id: 'notification-answers', bookId: 'aot-answers', asin: 'B07HNXWX2Y', status: 'pending' }
    ],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-21T01:00:00.000Z'
  });

  const attackBooks = store.books.filter((book) => book.seriesName === '進撃の巨人');
  const kamuiBooks = store.books.filter((book) => book.seriesName === 'カムイ伝全集 カムイ外伝');

  assert.equal(summary.changed, true);
  assert.equal(summary.removedSupplementalSeriesItems, 2);
  assert.equal(summary.removedHistory, 1);
  assert.equal(summary.removedNotifications, 1);
  assert.equal(attackBooks.length, 34);
  assert.deepEqual([...new Set(attackBooks.map((book) => book.seriesExpectedCount))], [34]);
  assert.equal(store.books.some((book) => book.asin === 'B01DLJNQK2' || book.asin === 'B07HNXWX2Y'), false);
  assert.equal(kamuiBooks.length, 2);
});

test('store repair removes unvalidated synthetic tail volumes re-added by an older workflow', () => {
  const store = {
    books: [
      ...Array.from({ length: 34 }, (_, index) => ({
        id: `aot-${index + 1}`,
        asin: `B00AOT${String(index + 1).padStart(4, '0')}`,
        title: `進撃の巨人 ${index + 1}`,
        seriesName: '進撃の巨人',
        seriesKey: 'series:asin:B009KYC6S6',
        seriesExpectedCount: 38,
        importMode: 'kindle_series',
        volume: index + 1,
        currentPrice: 550,
        currentPoints: 0,
        effectivePrice: 550
      })),
      {
        id: 'aot-unvalidated-35',
        asin: 'B00JDYKLPS',
        title: '進撃の巨人 ３５',
        seriesName: '進撃の巨人',
        seriesKey: 'series:asin:B009KYC6S6',
        seriesExpectedCount: 38,
        importMode: 'kindle_series',
        volume: 35,
        currentPrice: null,
        currentPoints: 0,
        effectivePrice: null,
        provider: 'pending_series',
        lastError: 'シリーズ価格補完: Amazon HTMLで価格補完できませんでした'
      },
      {
        id: 'aot-unvalidated-36',
        asin: 'B01DLJNQK2',
        title: '進撃の巨人 ３６',
        seriesName: '進撃の巨人',
        seriesKey: 'series:asin:B009KYC6S6',
        seriesExpectedCount: 38,
        importMode: 'kindle_series',
        volume: 36,
        currentPrice: null,
        currentPoints: 0,
        effectivePrice: null,
        provider: 'pending_series',
        lastError: 'シリーズ価格補完: HTTP取得がタイムアウトしました'
      }
    ],
    priceHistory: [
      { id: 'history-tail', bookId: 'aot-unvalidated-35', asin: 'B00JDYKLPS', checkedAt: '2026-05-20T00:00:00.000Z' }
    ],
    notifications: [],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-21T02:00:00.000Z'
  });

  const attackBooks = store.books.filter((book) => book.seriesName === '進撃の巨人');
  assert.equal(summary.changed, true);
  assert.equal(summary.removedUnvalidatedSeriesTailItems, 2);
  assert.equal(summary.removedHistory, 1);
  assert.equal(attackBooks.length, 34);
  assert.deepEqual([...new Set(attackBooks.map((book) => book.seriesExpectedCount))], [34]);
  assert.equal(store.books.some((book) => book.asin === 'B00JDYKLPS' || book.asin === 'B01DLJNQK2'), false);
});

test('store repair lowers stale expected count for completed contiguous series', () => {
  const store = {
    books: Array.from({ length: 7 }, (_, index) => ({
      id: `desco-${index + 1}`,
      asin: `B00DESCO${index + 1}`,
      title: `デスコ ${index + 1}`,
      seriesName: 'デスコ',
      seriesKey: 'series:asin:B00ORJ3X4K',
      seriesExpectedCount: 8,
      seriesCompleted: true,
      importMode: 'kindle_series',
      volume: index + 1,
      currentPrice: 224,
      currentPoints: 0,
      effectivePrice: 224
    })),
    priceHistory: [],
    notifications: [],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-21T03:00:00.000Z'
  });

  assert.equal(summary.changed, true);
  assert.equal(summary.repairedSeriesExpectedCounts, 7);
  assert.deepEqual([...new Set(store.books.map((book) => book.seriesExpectedCount))], [7]);
});

test('store repair fixes title-backed volumes and drops ambiguous duplicate series entries', () => {
  const store = {
    books: [
      {
        id: 'spunk-source',
        asin: 'B0C6JS577Q',
        title: 'SPUNK - スパンク！ - 1 (ビームコミックス)',
        seriesName: 'SPUNK - スパンク！',
        seriesKey: 'series:asin:B0C6JS577Q',
        seriesExpectedCount: 6,
        importMode: 'kindle_series',
        volume: 6,
        currentPrice: 257,
        currentPoints: 0,
        effectivePrice: 257,
        provider: 'listasin'
      },
      {
        id: 'spunk-ambiguous',
        asin: 'B0CQZKSKLG',
        title: 'SPUNK - スパンク！ -',
        seriesName: 'SPUNK - スパンク！',
        seriesKey: 'series:asin:B0C6JS577Q',
        seriesExpectedCount: 6,
        importMode: 'kindle_series',
        volume: 1,
        currentPrice: 778,
        currentPoints: 0,
        effectivePrice: 778,
        provider: 'amazon_html'
      },
      ...[2, 3, 4].map((volume) => ({
        id: `spunk-${volume}`,
        asin: `B0SPUNK000${volume}`,
        title: `SPUNK - スパンク！ - ${volume} (ビームコミックス)`,
        seriesName: 'SPUNK - スパンク！',
        seriesKey: 'series:asin:B0C6JS577Q',
        seriesExpectedCount: 6,
        importMode: 'kindle_series',
        volume,
        currentPrice: 264,
        currentPoints: 0,
        effectivePrice: 264,
        provider: 'listasin'
      }))
    ],
    priceHistory: [
      { id: 'history-ambiguous', bookId: 'spunk-ambiguous', asin: 'B0CQZKSKLG', checkedAt: '2026-05-20T00:00:00.000Z' }
    ],
    notifications: [
      { id: 'notification-ambiguous', bookId: 'spunk-ambiguous', asin: 'B0CQZKSKLG', status: 'pending' }
    ],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-21T03:10:00.000Z'
  });

  assert.equal(summary.changed, true);
  assert.equal(summary.repairedSeriesVolumes, 1);
  assert.equal(summary.removedDuplicateSeriesVolumeItems, 1);
  assert.equal(summary.removedHistory, 1);
  assert.equal(summary.removedNotifications, 1);
  assert.equal(store.books.some((book) => book.asin === 'B0CQZKSKLG'), false);
  assert.equal(store.books.find((book) => book.asin === 'B0C6JS577Q').volume, 1);
  assert.deepEqual([...new Set(store.books.map((book) => book.seriesExpectedCount))], [4]);
  assert.deepEqual(store.books.map((book) => book.volume).sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('store repair maps upper and lower part markers to series volumes', () => {
  const store = {
    books: [
      {
        id: 'ginga-upper',
        asin: 'B075M4B2B1',
        title: '銀河の死なない子供たちへ（上） (電撃コミックスNEXT)',
        seriesName: '銀河の死なない子供たちへ（上）',
        seriesKey: 'series:asin:B075M4B2B1',
        seriesExpectedCount: 2,
        importMode: 'kindle_series',
        volume: 2,
        currentPrice: 564,
        currentPoints: 0,
        effectivePrice: 564,
        provider: 'listasin'
      },
      {
        id: 'ginga-lower',
        asin: 'B07GDBC2SD',
        title: '銀河の死なない子供たちへ（下） (電撃コミックスNEXT)',
        seriesName: '銀河の死なない子供たちへ（上）',
        seriesKey: 'series:asin:B075M4B2B1',
        seriesExpectedCount: 2,
        importMode: 'kindle_series',
        volume: 2,
        currentPrice: 594,
        currentPoints: 0,
        effectivePrice: 594,
        provider: 'listasin'
      }
    ],
    priceHistory: [],
    notifications: [],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-21T03:20:00.000Z'
  });

  assert.equal(summary.changed, true);
  assert.equal(summary.repairedSeriesVolumes, 1);
  assert.deepEqual(
    store.books.sort((a, b) => a.asin.localeCompare(b.asin)).map((book) => [book.asin, book.volume]),
    [
      ['B075M4B2B1', 1],
      ['B07GDBC2SD', 2]
    ]
  );
});

test('store repair fixes known mixed-edition series volumes from stable ASINs', () => {
  const store = {
    books: [
      {
        id: 'shamo-1',
        asin: 'B00QAEZKNC',
        title: '軍鶏 １',
        seriesName: '軍鶏',
        seriesKey: 'series:asin:B074CG522D',
        seriesExpectedCount: 34,
        importMode: 'kindle_series',
        volume: 1,
        currentPrice: 1362,
        currentPoints: 0,
        effectivePrice: 1362,
        provider: 'amazon_series_bulk'
      },
      {
        id: 'shamo-4',
        asin: 'B00QAEZLAY',
        title: '軍鶏 １２',
        seriesName: '軍鶏',
        seriesKey: 'series:asin:B074CG522D',
        seriesExpectedCount: 34,
        importMode: 'kindle_series',
        volume: 12,
        currentPrice: 1362,
        currentPoints: 0,
        effectivePrice: 1362,
        provider: 'amazon_series_bulk'
      },
      ...[2, 3, ...Array.from({ length: 18 }, (_, index) => index + 5)].map((volume) => {
        return {
          id: `shamo-${volume}`,
          asin: `B00SHAMO${String(volume).padStart(2, '0')}`,
          title: `軍鶏 ${volume}`,
          seriesName: '軍鶏',
          seriesKey: 'series:asin:B074CG522D',
          seriesExpectedCount: 34,
          importMode: 'kindle_series',
          volume,
          currentPrice: 792,
          currentPoints: 0,
          effectivePrice: 792,
          provider: 'amazon_series_bulk'
        };
      })
    ],
    priceHistory: [],
    notifications: [],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-21T03:30:00.000Z'
  });

  assert.equal(summary.changed, true);
  assert.equal(store.books.find((book) => book.asin === 'B00QAEZLAY').volume, 4);
  assert.equal(
    store.books.find((book) => book.asin === 'B00QAEZLAY').title,
    '極厚版『軍鶏』 巻之四 （１０～１２巻相当） (イブニングコミックス)'
  );
  assert.deepEqual([...new Set(store.books.map((book) => book.seriesExpectedCount))], [22]);
});

test('store repair removes inferior exact-title duplicate before applying known expected count', () => {
  const store = {
    books: [
      {
        id: 'sekirara-1',
        asin: 'B082WYVC7D',
        title: 'セキララ結婚生活',
        seriesName: '７年目のセキララ結婚生活',
        seriesKey: 'series:asin:B082WZ2KT2',
        seriesExpectedCount: 5,
        importMode: 'kindle_series',
        volume: 1,
        author: 'けら えいこ (著)',
        imageUrl: 'https://example.com/cover.jpg',
        currentPrice: 855,
        currentPoints: 0,
        effectivePrice: 855,
        provider: 'listasin'
      },
      {
        id: 'sekirara-duplicate',
        asin: 'B085FWKSVV',
        title: 'セキララ結婚生活',
        seriesName: '７年目のセキララ結婚生活',
        seriesKey: 'series:asin:B082WZ2KT2',
        seriesExpectedCount: 5,
        importMode: 'kindle_series',
        volume: 1,
        imageUrl: 'https://example.com/cover.jpg',
        currentPrice: 1710,
        currentPoints: 0,
        effectivePrice: 1710,
        provider: 'amazon_html'
      },
      {
        id: 'sekirara-2',
        asin: 'B082WZ2KT2',
        title: '７年目のセキララ結婚生活',
        seriesName: '７年目のセキララ結婚生活',
        seriesKey: 'series:asin:B082WZ2KT2',
        seriesExpectedCount: 5,
        importMode: 'kindle_series',
        volume: 5,
        author: 'けら えいこ (著)',
        currentPrice: 855,
        currentPoints: 0,
        effectivePrice: 855,
        provider: 'listasin'
      }
    ],
    priceHistory: [
      { id: 'history-sekirara-duplicate', bookId: 'sekirara-duplicate', asin: 'B085FWKSVV', checkedAt: '2026-05-20T00:00:00.000Z' }
    ],
    notifications: [],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-21T03:40:00.000Z'
  });

  assert.equal(summary.changed, true);
  assert.equal(summary.removedDuplicateSeriesVolumeItems, 1);
  assert.equal(store.books.some((book) => book.asin === 'B085FWKSVV'), false);
  assert.equal(store.books.find((book) => book.asin === 'B082WZ2KT2').volume, 2);
  assert.deepEqual([...new Set(store.books.map((book) => book.seriesExpectedCount))], [2]);
});

test('supplemental series title detection preserves series whose own name contains the marker', () => {
  assert.equal(
    isSupplementalSeriesBookTitle('ダーウィン事変公式 ヒトとサルの境界線 (アフタヌーンコミックス)', 'ダーウィン事変'),
    true
  );
  assert.equal(
    isSupplementalSeriesBookTitle('進撃の巨人 悔いなき選択（１） (ＡＲＩＡコミックス)', '進撃の巨人'),
    true
  );
  assert.equal(
    isSupplementalSeriesBookTitle('カムイ伝全集 カムイ外伝 １', 'カムイ伝全集 カムイ外伝'),
    false
  );
});

test('store repair canonicalizes noisy series child titles for the same series', () => {
  const store = {
    books: [
      {
        id: 'kaiji-1',
        asin: 'B00KAIJI01',
        title: '賭博堕天録 カイジ 和也編 １ 賭博堕天録カイジ 和也編',
        seriesName: '賭博堕天録 カイジ 和也編',
        seriesKey: 'series:asin:B00KAIJI01',
        seriesExpectedCount: 3,
        importMode: 'kindle_series',
        volume: 1,
        currentPrice: 440,
        currentPoints: 0,
        effectivePrice: 440,
        provider: 'amazon_series_child'
      },
      {
        id: 'bambi-1',
        asin: 'B00BAMBI01',
        title: 'BAMBi 1 remodeled BAMBi remodeled (ビームコミックス)',
        seriesName: 'BAMBi remodeled',
        seriesKey: 'series:asin:B00BAMBI01',
        seriesExpectedCount: 6,
        importMode: 'kindle_series',
        volume: 1,
        currentPrice: 440,
        currentPoints: 0,
        effectivePrice: 440,
        provider: 'amazon_series_child'
      }
    ],
    priceHistory: [],
    notifications: [],
    seriesPriceHistory: []
  };

  const summary = repairStorePriceState(store, {
    clearCurrent: false,
    now: '2026-05-12T02:30:00.000Z'
  });

  assert.equal(summary.changed, true);
  assert.equal(store.books[0].title, '賭博堕天録 カイジ 和也編 １');
  assert.equal(store.books[1].title, 'BAMBi remodeled １');
});

test('series snapshots reject unvalidated source-wide series prices', () => {
  assert.equal(
    seriesSnapshotFromKindleSeriesForBook({
      items: [
        {
          asin: 'B085VPHHNK',
          currentPrice: 100,
          currentPoints: 0,
          provider: 'amazon_series_source_price'
        }
      ]
    }, 'B085VPHHNK'),
    null
  );
});

test('series snapshots accept unvalidated series prices after trusted sibling confirmation', () => {
  const series = {
    items: [
      {
        asin: 'B08YJWRJ4V',
        currentPrice: 759,
        currentPoints: 28,
        effectivePrice: 731,
        provider: 'sale_bon_series'
      },
      {
        asin: 'B0995RQYYJ',
        currentPrice: 759,
        currentPoints: 28,
        effectivePrice: 731,
        provider: 'sale_bon_series'
      },
      {
        asin: 'B0DTT876R5',
        currentPrice: 759,
        currentPoints: 28,
        effectivePrice: 731,
        provider: 'sale_bon_series'
      }
    ]
  };
  const store = {
    books: [
      {
        asin: 'B08YJWRJ4V',
        seriesKey: 'series:asin:B0F4RMYRKN',
        currentPrice: 759,
        currentPoints: 28,
        effectivePrice: 731,
        provider: 'amazon_html'
      },
      {
        asin: 'B0995RQYYJ',
        seriesKey: 'series:asin:B0F4RMYRKN',
        currentPrice: 759,
        currentPoints: 28,
        effectivePrice: 731,
        provider: 'listasin'
      }
    ]
  };

  const snapshot = seriesSnapshotFromKindleSeriesForBook(
    series,
    'B0DTT876R5',
    {
      asin: 'B0DTT876R5',
      seriesKey: 'series:asin:B0F4RMYRKN',
      seriesName: 'トリリオンゲーム'
    },
    { store }
  );

  assert.equal(snapshot.currentPrice, 759);
  assert.equal(snapshot.currentPoints, 28);
  assert.equal(snapshot.effectivePrice, 731);
  assert.equal(snapshot.provider, 'validated_series_fallback');
});

test('cached series prices can skip per-book network pacing only after the series candidate is resolved', () => {
  const book = {
    id: 'book-1',
    asin: 'B00TEST001',
    title: 'キャッシュ確認 1',
    importMode: 'kindle_series',
    sourceUrl: 'series-input',
    currentPrice: 500,
    effectivePrice: 500,
    provider: 'amazon_series_bulk'
  };
  const series = {
    items: [
      {
        asin: 'B00TEST001',
        currentPrice: 500,
        currentPoints: 0,
        effectivePrice: 500,
        provider: 'amazon_series_bulk'
      }
    ]
  };

  assert.equal(
    canUseCachedSeriesPriceSnapshotForBook(book, {
      seriesCandidateCache: new Map([['series:series-input', series]]),
      store: { books: [book] }
    }),
    true
  );

  assert.equal(
    canUseCachedSeriesPriceSnapshotForBook(book, {
      seriesCandidateCache: new Map([['series:series-input', Promise.resolve(series)]]),
      store: { books: [book] }
    }),
    false
  );
});

test('discounted prices are prioritized for expiry recheck after a day', () => {
  const checkedAt = new Date(Date.UTC(2026, 4, 10, 0, 0, 0)).toISOString();

  assert.equal(
    needsDiscountExpiryRecheck({
      currentPrice: 200,
      currentPoints: 2,
      effectivePrice: 198,
      listPrice: 440,
      provider: 'amazon_html',
      lastCheckedAt: checkedAt
    }, Date.UTC(2026, 4, 11, 1, 0, 0)),
    true
  );

  assert.equal(
    needsDiscountExpiryRecheck({
      currentPrice: 396,
      currentPoints: 4,
      effectivePrice: 392,
      listPrice: 440,
      provider: 'amazon_html',
      lastCheckedAt: checkedAt
    }, Date.UTC(2026, 4, 11, 1, 0, 0)),
    false
  );
});

test('list price challenge only targets successful current-price checks without direct list price', () => {
  const store = {
    books: [
      {
        id: 'target',
        asin: 'B000000001',
        currentPrice: 330,
        effectivePrice: 327,
        provider: 'validated_series_fallback'
      },
      {
        id: 'already',
        asin: 'B000000002',
        currentPrice: 330,
        effectivePrice: 327,
        listPrice: 660,
        listPriceProvider: 'amazon_html',
        provider: 'validated_series_fallback'
      },
      {
        id: 'failed',
        asin: 'B000000003',
        currentPrice: 330,
        effectivePrice: 327,
        provider: 'amazon_html'
      }
    ]
  };

  const selected = selectListPriceChallengeCandidates(
    store,
    [
      { ok: true, book: { id: 'target' } },
      { ok: true, book: { id: 'already' } },
      { ok: false, book: { id: 'failed' }, error: 'タイムアウト' }
    ],
    50
  );

  assert.equal(selected.eligible, 1);
  assert.deepEqual(selected.books.map((book) => book.id), ['target']);
});

test('list price challenge spreads attempts across series before trying more volumes', () => {
  const books = [
    ...Array.from({ length: 5 }, (_, index) => challengeBook(`a-${index + 1}`, 'series-a')),
    ...Array.from({ length: 3 }, (_, index) => challengeBook(`b-${index + 1}`, 'series-b')),
    ...Array.from({ length: 2 }, (_, index) => challengeBook(`c-${index + 1}`, 'series-c')),
    challengeBook('single-1', '')
  ];
  const selected = selectListPriceChallengeCandidates(
    { books },
    books.map((book) => ({ ok: true, book: { id: book.id } })),
    8
  );

  assert.equal(selected.eligible, 11);
  assert.deepEqual(
    selected.books.map((book) => book.id),
    ['a-1', 'b-1', 'c-1', 'single-1', 'a-2', 'b-2', 'c-2']
  );
});

test('list price challenge rejects candidates far above established price history', () => {
  const book = {
    id: 'book-1',
    asin: 'B000000001',
    currentPrice: 500,
    effectivePrice: 495,
    provider: 'amazon_html'
  };
  const store = {
    priceHistory: [
      { bookId: 'book-1', asin: 'B000000001', price: 500, effectivePrice: 495, provider: 'amazon_html' },
      { bookId: 'book-1', asin: 'B000000001', price: 900, effectivePrice: 891, provider: 'amazon_html' }
    ]
  };

  assert.deepEqual(validateListPriceChallengeCandidate(book, 1200, store), { ok: true, reason: '' });
  assert.deepEqual(validateListPriceChallengeCandidate(book, 3000, store), {
    ok: false,
    reason: 'above_price_history'
  });
});

function challengeBook(id, seriesKey) {
  return {
    id,
    asin: `B${id.replace(/[^A-Z0-9]/gi, '').padEnd(9, '0').slice(0, 9)}`.toUpperCase(),
    title: id,
    seriesKey,
    importMode: seriesKey ? 'kindle_series' : 'single',
    currentPrice: 330,
    effectivePrice: 327,
    provider: 'amazon_html'
  };
}

test('large incomplete series candidates capped at 50 items are not usable', () => {
  const items = Array.from({ length: 50 }, (_, index) => ({
    asin: `B09FLC${String(index + 1).padStart(4, '0')}`,
    title: `藤子・F・不二雄大全集 ${index + 1}`,
    volume: index + 1,
    currentPrice: 1000,
    imageUrl: `https://m.media-amazon.com/images/I/${index + 1}.jpg`,
    provider: 'amazon_series_child'
  }));

  assert.equal(
    isUsableIncompleteSeriesCandidate({
      seriesName: '藤子・F・不二雄大全集',
      expectedVolumeCount: 118,
      items
    }),
    false
  );
});

test('known Amazon placeholder images are treated as weak series covers', () => {
  assert.equal(isWeakSeriesImageUrl('https://m.media-amazon.com/images/I/A19VjRNYppL._SY300_.png'), true);
  assert.equal(isWeakSeriesImageUrl('https://m.media-amazon.com/images/I/513bgfa1haL._SY300_.jpg'), false);
});

test('completed series discovery becomes eligible for periodic recheck', () => {
  const group = {
    completed: true,
    books: [
      {
        seriesCompletedAt: '2026-05-01T00:00:00.000Z',
        seriesLastDiscoveredAt: '2026-05-01T00:00:00.000Z'
      }
    ]
  };

  assert.equal(shouldRecheckCompletedSeriesGroup(group, '2026-05-06T23:59:59.000Z'), false);
  assert.equal(shouldRecheckCompletedSeriesGroup(group, '2026-05-08T00:00:00.000Z'), true);
});
