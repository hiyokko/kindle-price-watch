import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  fetchBookSnapshot, fetchAmazonHtmlSnapshot, fetchExternalKindleSeriesItems,
  extractAmazonHtmlSnapshotFromHtml, extractKindleSeriesItemsFromAmazonReaderText
} from '../src/price-provider.mjs';
import { fetchSeriesCandidates, suspiciousSnapshotReason, repairStorePriceState } from '../src/checker.mjs';
import { awaitWithSignal } from '../src/request-signal.mjs';

const asin = 'B00G26729S';
const url = `https://www.amazon.co.jp/dp/${asin}`;
const title = 'Demeking';
const options = { title, currentPrice: 1320, retries: 0, skipThrottle: true, timeoutMs: 1000 };
const reader = `Title: Amazon.co.jp: ${title} eBook : Author: Kindle Store
URL Source: ${url}
Markdown Content:
Amazon Points:+7 pt
Submit Order
You will be charged JPY 660
Kindle Store Terms of Use
# ${title}
Format: Kindle Edition`;
const listasin = (record = {}) => JSON.stringify({ result: { books: {
  [asin]: { latest_price: 700, latest_point: 7, ...record }
} } });
const product = `<span id="productTitle">${title}</span><div id="tmm-grid-swatch-KINDLE">Kindle版
  <span class="a-color-price">￥660</span></div>`;

function setup(t, handler, overrides = {}) {
  const originalFetch = globalThis.fetch;
  const values = {
    PRICE_PROVIDER: 'amazon_html', AMAZON_DOMAIN: 'JP', KEEPA_API_KEY: '',
    HTTP_AMAZON_FETCH_RETRIES: '0', HTTP_REQUEST_MIN_INTERVAL_MS: '0', HTTP_REQUEST_JITTER_MS: '0',
    HTTP_BLOCK_COOLDOWN_MS: '0', AMAZON_READER_FALLBACK: 'true', LISTASIN_EARLY_FALLBACK: 'true',
    KINTYAKU_CATEGORY_NODES: '2278488051', ...overrides
  };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const hosts = [];
  globalThis.fetch = async (input, init) => {
    const parsed = new URL(input);
    hosts.push(parsed.hostname);
    init.signal?.throwIfAborted();
    return handler(parsed, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return hosts;
}

function untilAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('early listasIn success avoids Reader and Kintyaku', async t => {
  const hosts = setup(t, async parsed => parsed.hostname === 'www.listasin.net'
    ? new Response(listasin()) : new Response('blocked', { status: 403 }));
  assert.equal((await fetchBookSnapshot(asin, options)).provider, 'listasin');
  assert.deepEqual(hosts, ['www.amazon.co.jp', 'www.listasin.net']);
});

test('late listasIn retains configured ordering and each provider is visited once', async t => {
  const hosts = setup(t, async parsed => parsed.hostname === 'www.listasin.net'
    ? new Response(listasin()) : new Response('missing', { status: 404 }));
  await fetchBookSnapshot(asin, { ...options, preferListasinFallback: false });
  const supplemental = hosts.filter(host => host !== 'www.amazon.co.jp');
  assert.deepEqual(supplemental, ['r.jina.ai', 'kintyaku.net', 'www.listasin.net']);
});

test('a provider deadline leaves the parent alive and advances to Reader', async t => {
  const controller = new AbortController();
  const hosts = setup(t, async (parsed, init) => {
    if (parsed.hostname === 'www.listasin.net') return untilAbort(init.signal);
    if (parsed.hostname === 'r.jina.ai') return new Response(reader);
    return new Response('blocked', { status: 403 });
  });
  const snapshot = await fetchBookSnapshot(asin, { ...options, signal: controller.signal, fallbackMaxRuntimeMs: 30 });
  assert.equal(snapshot.currentPrice, 660);
  assert.equal(snapshot.readerPurchaseVerified, true);
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(hosts, ['www.amazon.co.jp', 'www.listasin.net', 'r.jina.ai']);
});

test('disabled external and Reader paths make no supplemental requests', async t => {
  const hosts = setup(t, async () => new Response('blocked', { status: 403 }));
  await assert.rejects(fetchBookSnapshot(asin, { ...options, allowExternalPriceFallback: false, allowAmazonReaderFallback: false }));
  assert.deepEqual(hosts, ['www.amazon.co.jp']);
});

for (const [name, record, error] of [
  ['wrong ASIN', { ASIN: 'B012345678' }, /ASIN/],
  ['foreign currency', { currency: 'USD' }, /JPY/],
  ['negative price', { latest_price: -700 }, /価格が不正/],
  ['negative string price', { latest_price: '-700' }, /価格データ/],
  ['negative points', { latest_point: -7 }, /ポイントが不正/],
  ['excessive points', { latest_point: 701 }, /ポイントが不正/]
]) {
  test(`listasIn rejects ${name}`, async t => {
    setup(t, async () => new Response(listasin(record)), { PRICE_PROVIDER: 'listasin' });
    await assert.rejects(fetchBookSnapshot(asin, options), error);
  });
}

test('invalid external data falls through to a verified Reader price', async t => {
  setup(t, async parsed => {
    if (parsed.hostname === 'www.listasin.net') return new Response(listasin({ latest_point: 701 }));
    if (parsed.hostname === 'r.jina.ai') return new Response(reader);
    return new Response('blocked', { status: 403 });
  });
  assert.equal((await fetchBookSnapshot(asin, options)).provider, 'amazon_reader');
});

test('Keepa has a bounded deadline and auto mode continues to the direct page', async t => {
  const controller = new AbortController();
  const hosts = setup(t, async (parsed, init) => parsed.hostname === 'api.keepa.com'
    ? untilAbort(init.signal) : new Response(product), { PRICE_PROVIDER: 'auto', KEEPA_API_KEY: 'test-only' });
  const result = await fetchBookSnapshot(asin, { ...options, signal: controller.signal, fallbackMaxRuntimeMs: 30 });
  assert.equal(result.provider, 'amazon_html');
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(hosts, ['api.keepa.com', 'www.amazon.co.jp']);
});

test('Keepa parent cancellation prevents direct fallthrough', async t => {
  const controller = new AbortController();
  const hosts = setup(t, async (parsed, init) => { controller.abort(); return untilAbort(init.signal); },
    { PRICE_PROVIDER: 'auto', KEEPA_API_KEY: 'test-only' });
  await assert.rejects(fetchBookSnapshot(asin, { ...options, signal: controller.signal }), /aborted/i);
  assert.deepEqual(hosts, ['api.keepa.com']);
});

test('metadata-only Keepa results do not stop price acquisition in auto mode', async t => {
  const hosts = setup(t, async parsed => parsed.hostname === 'api.keepa.com'
    ? new Response(JSON.stringify({ products: [{ asin, title, stats: { current: [] } }] })) : new Response(product),
    { PRICE_PROVIDER: 'auto', KEEPA_API_KEY: 'test-only' });
  const snapshot = await fetchBookSnapshot(asin, options);
  assert.equal(snapshot.currentPrice, 660);
  assert.equal(snapshot.provider, 'amazon_html');
  assert.deepEqual(hosts, ['api.keepa.com', 'www.amazon.co.jp']);
});

test('Keepa rejects mismatched identity and non-Japanese domains', async t => {
  const hosts = setup(t, async () => new Response(JSON.stringify({ products: [{ asin: 'B012345678', title, stats: { current: [660] } }] })),
    { PRICE_PROVIDER: 'keepa', KEEPA_API_KEY: 'test-only' });
  await assert.rejects(fetchBookSnapshot(asin, options), /ASIN/);
  process.env.AMAZON_DOMAIN = 'US';
  await assert.rejects(fetchBookSnapshot(asin, options), /JPY/);
  assert.equal(hosts.length, 1);
});

for (const currency of ['USD', 'JPY']) {
  test(`Kintyaku ${currency} offers are ${currency === 'JPY' ? 'accepted' : 'rejected'}`, async t => {
    setup(t, async parsed => {
      if (parsed.hostname !== 'kintyaku.net') return new Response('missing', { status: 404 });
      return new Response(JSON.stringify({ Items: [{ ASIN: asin, ItemInfo: { Title: { DisplayValue: title } },
        Offers: { Listings: [{ Price: { Amount: 660, Currency: currency }, LoyaltyPoints: { Points: 7 } }] } }] }));
    });
    const result = fetchBookSnapshot(asin, { ...options, allowAmazonReaderFallback: false });
    if (currency === 'JPY') assert.equal((await result).provider, 'kintyaku');
    else await assert.rejects(result, /商品データ/);
  });
}

test('Reader recommendation prices and points cannot become the main offer', async t => {
  const text = `Title: ${title}\nURL Source: ${url}\n# ${title}\nFormat: Kindle Edition
## Customers who bought this item also bought
Kindle Price: JPY 990
Amazon Points:+990 pt`;
  setup(t, async parsed => parsed.hostname === 'r.jina.ai' ? new Response(text) : new Response('missing', { status: 404 }));
  const snapshot = await fetchAmazonHtmlSnapshot(asin, url, options);
  assert.equal(snapshot.currentPrice, null);
  assert.equal(snapshot.currentPoints, 0);
});

test('Reader series identity is checked against the actual requested sibling seed', () => {
  const sibling = 'B012345678';
  assert.throws(() => extractKindleSeriesItemsFromAmazonReaderText(`URL Source: ${url}`, url, `https://www.amazon.co.jp/dp/${sibling}`), /ASIN/);
  assert.doesNotThrow(() => extractKindleSeriesItemsFromAmazonReaderText(`URL Source: ${url}`, `https://www.amazon.co.jp/dp/${sibling}`, url));
});

test('direct HTML checks main identity without confusing recommended products', () => {
  assert.throws(() => extractAmazonHtmlSnapshotFromHtml(`<input value="B012345678" id = "ASIN">${product}`, asin, url), /ASIN/);
  assert.throws(() => extractAmazonHtmlSnapshotFromHtml(`<link href="https://www.amazon.co.jp/dp/B012345678" rel="canonical">${product}`, asin, url), /ASIN/);
  assert.equal(extractAmazonHtmlSnapshotFromHtml(`<div data-asin="B012345678"></div>${product}`, asin, url).currentPrice, 660);
});

for (const target of ['sale-bon.com', 'kintyaku.net', 'www.efox.jp', 'kinpome.com']) {
  test(`series fallback propagates cancellation at ${target} and stops later providers`, async t => {
    const controller = new AbortController();
    const seriesHtml = `<meta property="og:title" content="Runtime Series (全2巻)"><div id="series-childAsin-list">
      ${['B074222222', 'B074333333'].map((item, i) => `<div id="series-childAsin-item_${i}" data-asin="${item}">
      <a href="/dp/${item}" title="Runtime Series ${i + 1}">Runtime Series ${i + 1}</a><span class="a-color-price">￥500</span></div>`).join('')}</div>`;
    const hosts = setup(t, async (parsed, init) => {
      if (parsed.hostname === target) { controller.abort(); return untilAbort(init.signal); }
      if (parsed.hostname === 'www.amazon.co.jp') return new Response(seriesHtml);
      return new Response('missing', { status: 404 });
    });
    await assert.rejects(fetchSeriesCandidates('https://www.amazon.co.jp/dp/B074111111', {
      ...options, signal: controller.signal, skipBackfill: true, probeSeriesCompletion: false
    }), /aborted/i);
    assert.equal(hosts.at(-1), target);
    assert.ok(hosts.includes(target));
  });
}

test('queued host cancellation is prompt even behind a throttled request', async t => {
  const waiting = new AbortController();
  const cancelled = new AbortController();
  let requests = 0;
  setup(t, async () => { requests += 1; return new Response('blocked', { status: 403 }); }, { HTTP_BLOCK_COOLDOWN_MS: '10000' });
  const input = 'https://www.amazon.co.jp/dp/B074111111';
  await fetchExternalKindleSeriesItems(input, { timeoutMs: 1000 });
  const blocker = fetchExternalKindleSeriesItems(input, { timeoutMs: 2000, signal: waiting.signal });
  const behind = fetchExternalKindleSeriesItems(input, { timeoutMs: 2000, signal: cancelled.signal });
  cancelled.abort();
  const deadline = setTimeout(() => waiting.abort(), 500);
  try {
    await assert.rejects(behind, /aborted/i);
    assert.equal(waiting.signal.aborted, false);
    assert.equal(requests, 1);
  } finally { clearTimeout(deadline); waiting.abort(); await assert.rejects(blocker); }
});

test('abortable waits release listeners and observe later rejection after early cancellation', async () => {
  const controller = new AbortController();
  assert.equal(await awaitWithSignal(Promise.resolve(1), controller.signal), 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  await assert.rejects(awaitWithSignal(Promise.reject(new Error('late rejection')), controller.signal), /aborted/i);
});

test('only explicit verified Reader purchases bypass the conservative discount guard', () => {
  const book = { currentPrice: 1320 };
  const snapshot = { currentPrice: 660, currentPoints: 7, effectivePrice: 653, provider: 'amazon_reader' };
  assert.match(suspiciousSnapshotReason(book, { ...snapshot, explicitPriceDisplay: true }), /reader/);
  assert.match(suspiciousSnapshotReason(book, { ...snapshot, readerPurchaseVerified: true }), /reader/);
  assert.equal(suspiciousSnapshotReason(book, { ...snapshot, explicitPriceDisplay: true, readerPurchaseVerified: true }), '');
});

test('invalid numeric observations and points are rejected before persistence', () => {
  for (const value of [NaN, Infinity, -1]) {
    assert.ok(suspiciousSnapshotReason({}, { currentPrice: value }));
    assert.ok(suspiciousSnapshotReason({}, { currentPrice: 660, currentPoints: value }));
  }
});

test('history restoration carries the verification evidence with the restored price', () => {
  const book = { id: 'reader-book', asin, title, currentPrice: -10, currentPoints: 0,
    effectivePrice: -10, listPrice: 1320, provider: 'amazon_html' };
  const store = { books: [book], priceHistory: [{ bookId: book.id, asin, price: 660, points: 7,
    effectivePrice: 653, provider: 'amazon_reader', explicitPriceDisplay: true, readerPurchaseVerified: true,
    checkedAt: '2026-11-19T00:00:00Z' }], notifications: [], seriesPriceHistory: [] };
  repairStorePriceState(store);
  assert.equal(book.currentPrice, 660);
  assert.equal(book.readerPurchaseVerified, true);
  assert.equal(suspiciousSnapshotReason({ currentPrice: 1320 }, book), '');
});

test('a full isolated check preserves verified discount evidence across saving, reloading and repair', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kpw-fallback-test-'));
  const checkerUrl = new URL('../src/checker.mjs', import.meta.url).href;
  const book = { id: 'reader-book', asin, title, currentPrice: 1320, currentPoints: 13, effectivePrice: 1307,
    listPrice: 1320, provider: 'amazon_html', importMode: 'single', lastCheckedAt: '2026-11-14T00:00:00Z' };
  const notification = { id: 'existing', bookId: 'other', status: 'sent' };
  try {
    await mkdir(path.join(cwd, 'data'));
    await writeFile(path.join(cwd, 'data/store.json'), JSON.stringify({ books: [book],
      priceHistory: [], seriesPriceHistory: [], notifications: [notification], settings: { notificationThreshold: 80, batchSize: 1 } }));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      globalThis.fetch = async input => new URL(input).hostname === 'r.jina.ai'
        ? new Response(${JSON.stringify(reader)}) : new Response('blocked', { status: 403 });
      const { runDueChecks, repairStorePriceState, suspiciousSnapshotReason } = await import(${JSON.stringify(checkerUrl)});
      const result = await runDueChecks({ source: 'manual', force: true, notify: false, discoverSeries: false,
        discoverCheckedSeries: false, importQueue: false, singleSeriesAudit: false, listPriceChallenge: false, priceIntegrityAudit: false });
      const { readFile } = await import('node:fs/promises');
      const saved = JSON.parse(await readFile('data/store.json', 'utf8'));
      const before = structuredClone(saved);
      repairStorePriceState(saved, { now: before.books[0].updatedAt });
      globalThis.fetch = async () => new Response(${JSON.stringify(product)});
      await runDueChecks({ source: 'manual', force: true, notify: false, discoverSeries: false,
        discoverCheckedSeries: false, importQueue: false, singleSeriesAudit: false, listPriceChallenge: false, priceIntegrityAudit: false });
      const next = JSON.parse(await readFile('data/store.json', 'utf8'));
      console.log(JSON.stringify({ result, saved, before, next }));
    `], { cwd, encoding: 'utf8', timeout: 10000, env: { ...process.env,
      BLOB_READ_WRITE_TOKEN: '', KPW_RUNTIME_ENV_FILE: '', PRICE_PROVIDER: 'amazon_html', KEEPA_API_KEY: '',
      AMAZON_READER_FALLBACK: 'true', LISTASIN_EARLY_FALLBACK: 'true', SERIES_PRICE_CHECK_FIRST: 'false',
      CHECK_MAX_RUNTIME_MS: '0', CHECK_REQUEST_DELAY_MS: '0', CHECK_REQUEST_JITTER_MS: '0',
      HTTP_REQUEST_MIN_INTERVAL_MS: '0', HTTP_REQUEST_JITTER_MS: '0', HTTP_BLOCK_COOLDOWN_MS: '0', HTTP_AMAZON_FETCH_RETRIES: '0'
    } });
    assert.equal(child.status, 0, child.stderr);
    const { result, saved, before, next } = JSON.parse(child.stdout);
    assert.equal(result.results[0].ok, true, JSON.stringify(result.results[0]));
    assert.equal(saved.books[0].currentPrice, 660);
    assert.equal(saved.books[0].readerPurchaseVerified, true);
    assert.equal(saved.priceHistory.at(-1).readerPurchaseVerified, true);
    assert.deepEqual(saved, before);
    assert.equal(saved.settings.notificationThreshold, 80);
    assert.deepEqual(saved.notifications, [notification]);
    assert.equal(next.books[0].provider, 'amazon_html');
    assert.equal(next.books[0].readerPurchaseVerified, false);
    assert.equal(next.priceHistory.at(-1).readerPurchaseVerified, false);
    assert.equal(next.priceHistory[0].readerPurchaseVerified, true);
    assert.deepEqual(next.notifications, [notification]);
    assert.equal(JSON.parse(await readFile(path.join(cwd, 'data/store.json'), 'utf8')).books[0].currentPrice, 660);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
