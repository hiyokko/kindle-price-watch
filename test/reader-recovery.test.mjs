import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchAmazonHtmlSnapshot, shouldDeferAmazonReaderPrice } from '../src/price-provider.mjs';
import { isUnusableBookTitle, preferBookTitle, recoverBookTitle } from '../src/book-title.mjs';
import { repairStorePriceState } from '../src/checker.mjs';

const asin = 'B00G26729S';
const sourceUrl = `https://www.amazon.co.jp/dp/${asin}`;
const title = 'デメキング 完結版';

function readerText({ source = sourceUrl, heading = title, reportedTitle = `Amazon.co.jp: ${title} eBook : いましろたかし: Kindle Store` } = {}) {
  return `Title: ${reportedTitle}
URL Source: ${source}
Markdown Content:
Amazon Points:+999 pt
${'unrelated navigation '.repeat(100)}
Amazon Points:+7 pt (1%)
Submit Order
You will be charged JPY 660
Kindle Store Terms of Use
# ${heading}
Format: Kindle Edition
`;
}

function mockReader(t, text, { metadataOnly = false } = {}) {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    seen.push(String(url));
    if (parsed.hostname === 'www.amazon.co.jp') {
      return metadataOnly
        ? new Response(`<span id="productTitle">${title}</span><div id="tmm-grid-swatch-KINDLE">Kindle版</div>`)
        : new Response('blocked', { status: 403 });
    }
    if (parsed.hostname === 'www.listasin.net') return new Response('{"result":{"books":{}}}');
    if (parsed.hostname === 'r.jina.ai') {
      assert.equal(String(url), `https://r.jina.ai/${sourceUrl}`);
      return new Response(text);
    }
    return new Response('not found', { status: 404 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return seen;
}

const options = { title, currentPrice: 1294, retries: 0, skipThrottle: true, timeoutMs: 1000 };

test('a blocked Amazon page can recover an ASIN-verified discounted Kindle buybox through the correct Reader URL', async t => {
  const seen = mockReader(t, readerText());
  const snapshot = await fetchAmazonHtmlSnapshot(asin, sourceUrl, options);
  assert.equal(snapshot.title, title);
  assert.equal(snapshot.currentPrice, 660);
  assert.equal(snapshot.currentPoints, 7);
  assert.equal(snapshot.effectivePrice, 653);
  assert.equal(snapshot.provider, 'amazon_reader');
  assert.equal(snapshot.readerPurchaseVerified, true);
  assert.equal(snapshot.explicitPriceDisplay, true);
  assert.equal(seen.filter(url => new URL(url).hostname === 'www.amazon.co.jp').length, 1);
});

test('Reader discount evidence survives merging with a metadata-only direct response', async t => {
  mockReader(t, readerText(), { metadataOnly: true });
  const snapshot = await fetchAmazonHtmlSnapshot(asin, sourceUrl, { ...options, allowAmazonExtendedFallback: false });
  assert.equal(snapshot.currentPrice, 660);
  assert.equal(snapshot.readerPurchaseVerified, true);
  assert.equal(snapshot.explicitPriceDisplay, true);
});

test('deep reader discounts without matching source evidence remain deferred', async t => {
  mockReader(t, readerText({ source: 'https://www.amazon.co.jp/' }).replace('Amazon Points:+999 pt', 'Amazon Points:+7 pt'));
  const snapshot = await fetchAmazonHtmlSnapshot(asin, sourceUrl, options);
  assert.equal(snapshot.currentPrice, null);
  assert.equal(snapshot.readerPurchaseVerified, false);
});

test('reader content for another ASIN is rejected even if its purchase price looks valid', async t => {
  mockReader(t, readerText({ source: 'https://www.amazon.co.jp/dp/B012345678' }));
  await assert.rejects(fetchAmazonHtmlSnapshot(asin, sourceUrl, options), /Readerの商品ASINまたは取得元が一致しません/);
});

test('a matching ASIN on a foreign source host cannot verify a reader price', async t => {
  mockReader(t, readerText({ source: `https://example.test/dp/${asin}` }));
  await assert.rejects(fetchAmazonHtmlSnapshot(asin, sourceUrl, options), /取得元が一致しません/);
});

test('an image URL in a reader title cannot replace the real product heading', async t => {
  mockReader(t, readerText({ reportedTitle: 'https://m.media-amazon.com/images/I/cover.jpg' }));
  assert.equal((await fetchAmazonHtmlSnapshot(asin, sourceUrl, options)).title, title);
});

test('reader opt-out and tiny-price safeguards remain effective', async t => {
  const seen = mockReader(t, readerText());
  await assert.rejects(fetchAmazonHtmlSnapshot(asin, sourceUrl, { ...options, allowAmazonReaderFallback: false }));
  assert.equal(seen.some(url => new URL(url).hostname === 'r.jina.ai'), false);
  assert.equal(shouldDeferAmazonReaderPrice({ provider: 'amazon_reader', currentPrice: 2, readerPurchaseVerified: true, explicitPriceDisplay: true }), true);
});

test('URL-like and markdown-image titles are invalid and cannot displace a good stored title', () => {
  for (const value of ['https://m.media', 'https://m.media-amazon.com/images/I/a.jpg', 'URL Source: https://example.test', '![cover](https://example.test/a.jpg)']) {
    assert.equal(isUnusableBookTitle(value), true);
    assert.equal(preferBookTitle(value, title), title);
  }
  assert.equal(preferBookTitle(`ASIN ${asin}`, title), title);
});

test('title recovery uses matching historical identity and never overwrites a valid title', () => {
  const book = { id: 'book', asin, title: 'https://m.media' };
  const history = [
    { bookId: book.id, asin: 'B012345678', title: 'Unrelated work' },
    { asin, title: 'https://m.media-amazon.com/images/I/a.jpg' },
    { asin, title, checkedAt: '2026-05-21T00:00:00Z' }
  ];
  assert.equal(recoverBookTitle(book, history), title);
  assert.equal(recoverBookTitle({ ...book, title: 'Valid current title' }, history), 'Valid current title');
  assert.equal(recoverBookTitle(book, history.slice(0, 2)), `ASIN ${asin}`);
});

test('store repair restores a corrupted title without refreshing its price or deleting history/notifications', () => {
  const book = { id: 'book', asin, title: 'https://m.media', provider: 'amazon_html',
    currentPrice: 1294, currentPoints: 13, effectivePrice: 1281, lastCheckedAt: '2026-11-14T00:00:00Z' };
  const store = { books: [book], priceHistory: [{ id: 'h', bookId: 'book', asin, title,
    price: 1294, points: 13, effectivePrice: 1281, provider: 'amazon_html', checkedAt: book.lastCheckedAt }],
    notifications: [{ id: 'n', bookId: 'book', status: 'sent' }], seriesPriceHistory: [] };
  const before = structuredClone(store);
  const result = repairStorePriceState(store, { now: '2026-11-19T00:00:00Z' });
  assert.equal(result.changed, true);
  assert.equal(book.title, title);
  assert.equal(book.lastCheckedAt, before.books[0].lastCheckedAt);
  assert.equal(book.currentPrice, before.books[0].currentPrice);
  assert.deepEqual(store.priceHistory, before.priceHistory);
  assert.deepEqual(store.notifications, before.notifications);
});
