import assert from 'node:assert/strict';
import test from 'node:test';

import {
  needsDiscountExpiryRecheck,
  seriesSnapshotFromKindleSeriesForBook,
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
      price: 3,
      points: 0,
      effectivePrice: 3,
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
