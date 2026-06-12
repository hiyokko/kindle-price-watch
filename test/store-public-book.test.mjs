import assert from 'node:assert/strict';
import test from 'node:test';

import { publicBook } from '../src/store.mjs';

test('public book output does not expose series-derived list prices for discount display', () => {
  const book = publicBook({
    id: 'book-1',
    asin: 'B0B6FJ8589',
    title: '天幕のジャードゥーガル 1',
    currentPrice: 594,
    currentPoints: 0,
    effectivePrice: 594,
    listPrice: 2376,
    provider: 'amazon_series_bulk'
  });

  assert.equal(book.listPrice, null);
  assert.equal(book.discountRate, null);
});

test('public book output keeps direct Amazon HTML list prices', () => {
  const book = publicBook({
    id: 'book-2',
    asin: 'B009KYC6S6',
    title: '進撃の巨人 1',
    currentPrice: 110,
    currentPoints: 1,
    effectivePrice: 109,
    listPrice: 594,
    provider: 'amazon_html'
  });

  assert.equal(book.listPrice, 594);
  assert.equal(book.discountRate, 82);
});

test('public book output keeps direct list price source when current price came from series', () => {
  const book = publicBook({
    id: 'book-3',
    asin: 'B009KYC6S6',
    title: '進撃の巨人 1',
    currentPrice: 110,
    currentPoints: 1,
    effectivePrice: 109,
    listPrice: 594,
    listPriceProvider: 'amazon_html',
    provider: 'validated_series_fallback'
  });

  assert.equal(book.listPrice, 594);
  assert.equal(book.discountRate, 82);
});

test('public book output exposes release dates for preorder volumes', () => {
  const book = publicBook({
    id: 'book-4',
    asin: 'B0H4PQCXY9',
    title: 'ダーウィン事変（１１） (アフタヌーンコミックス)',
    currentPrice: 792,
    currentPoints: 8,
    effectivePrice: 784,
    releaseDate: '2026-06-23',
    provider: 'amazon_html'
  });

  assert.equal(book.releaseDate, '2026-06-23');
});
