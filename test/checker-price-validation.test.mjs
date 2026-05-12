import assert from 'node:assert/strict';
import test from 'node:test';

import {
  needsDiscountExpiryRecheck,
  priceIntegrityIssueForBook,
  seriesSnapshotFromKindleSeriesForBook,
  snapshotInputUrlForBook,
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
