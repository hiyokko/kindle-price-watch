import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canUseCachedSeriesPriceSnapshotForBook,
  needsDiscountExpiryRecheck,
  isFutureReleaseDate,
  priceIntegrityIssueForBook,
  repairStorePriceState,
  seriesSnapshotFromKindleSeriesForBook,
  snapshotInputUrlForBook,
  summarizeCheckResultErrors,
  suspiciousSnapshotReason,
  suspiciousPriceReason
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
