import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
