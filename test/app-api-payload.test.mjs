import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapPayload, compactBooksPayload } from '../src/book-list-payload.mjs';

test('book list payload omits redundant defaults and canonical URLs', () => {
  const [book] = compactBooksPayload([
    {
      id: 'book-1',
      asin: 'B0B6FJ8589',
      title: '天幕のジャードゥーガル 1',
      imageUrl: 'https://example.com/cover.jpg',
      amazonUrl: 'https://www.amazon.co.jp/dp/B0B6FJ8589',
      importMode: 'single',
      currentPoints: 0,
      provider: 'amazon_html',
      previousEffectivePrice: 594,
      updatedAt: '2026-05-19T00:00:00.000Z',
      seriesCompleted: false,
      currentPrice: 594,
      effectivePrice: 594
    }
  ]);

  assert.equal(book.id, 'book-1');
  assert.equal(book.asin, 'B0B6FJ8589');
  assert.equal(book.imageUrl, 'https://example.com/cover.jpg');
  assert.equal(book.currentPrice, 594);
  assert.equal('amazonUrl' in book, false);
  assert.equal('importMode' in book, false);
  assert.equal('currentPoints' in book, false);
  assert.equal('provider' in book, false);
  assert.equal('previousEffectivePrice' in book, false);
  assert.equal('updatedAt' in book, false);
  assert.equal('seriesCompleted' in book, false);
});

test('book list payload keeps one copy of repeated series fields while preserving grouping keys', () => {
  const books = compactBooksPayload([
    {
      id: 'book-1',
      asin: 'B000000001',
      title: 'シリーズ 1',
      seriesKey: 'B0SERIES001',
      sourceUrl: 'https://www.amazon.co.jp/dp/B0SERIES001',
      seriesLowestEffectiveTotal: 1000,
      currentPrice: 500
    },
    {
      id: 'book-2',
      asin: 'B000000002',
      title: 'シリーズ 2',
      seriesKey: 'B0SERIES001',
      sourceUrl: 'https://www.amazon.co.jp/dp/B0SERIES001',
      seriesLowestEffectiveTotal: 1000,
      currentPrice: 500
    }
  ]);

  assert.equal(books[0].seriesKey, 'B0SERIES001');
  assert.equal(books[0].sourceUrl, 'https://www.amazon.co.jp/dp/B0SERIES001');
  assert.equal(books[0].seriesLowestEffectiveTotal, 1000);
  assert.equal(books[1].seriesKey, 'B0SERIES001');
  assert.equal('sourceUrl' in books[1], false);
  assert.equal('seriesLowestEffectiveTotal' in books[1], false);
});

test('bootstrap payload combines the compact book list and control state', () => {
  const payload = bootstrapPayload(
    [{ id: 'book-1', asin: 'B000000001', title: 'Book', currentPoints: 0 }],
    { settings: { batchSize: 50 }, automation: { lastCronChecked: 1000 } }
  );

  assert.equal(payload.books.length, 1);
  assert.equal(payload.books[0].id, 'book-1');
  assert.equal('currentPoints' in payload.books[0], false);
  assert.equal(payload.settings.batchSize, 50);
  assert.equal(payload.automation.lastCronChecked, 1000);
});
