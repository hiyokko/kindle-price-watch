import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canUseCachedSeriesPriceSnapshotForBook, settleSnapshot } from '../src/checker.mjs';

const sourceAsin = 'B074111111';
const bookAsin = 'B074222222';
const book = {
  id: 'runtime-book', asin: bookAsin, title: 'Runtime Series 1',
  seriesName: 'Runtime Series', seriesKey: `series:asin:${sourceAsin}`,
  sourceUrl: `https://www.amazon.co.jp/dp/${sourceAsin}`, importMode: 'kindle_series',
  currentPrice: 500, effectivePrice: 500, provider: 'amazon_html'
};

function installMockFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  const env = {
    PRICE_PROVIDER: 'amazon_html', HTTP_AMAZON_FETCH_RETRIES: '0',
    HTTP_REQUEST_MIN_INTERVAL_MS: '0', HTTP_REQUEST_JITTER_MS: '0',
    HTTP_BLOCK_COOLDOWN_MS: '0', SERIES_PRICE_CHECK_FIRST: 'true',
    SERIES_PRICE_FAILURE_RETRY_MS: '300000', CHECK_BOOK_MAX_RUNTIME_MS: '60000'
  };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

function productResponse() {
  return new Response(`<span id="productTitle">Runtime Series 1</span>
    <div id="tmm-grid-swatch-KINDLE">Kindle版
      <span class="a-color-price">￥500</span>
    </div>`, { status: 200 });
}

test('a slow series lookup leaves time for the individual book fallback', async t => {
  const requests = [];
  installMockFetch(t, async (url, options) => {
    requests.push(String(url));
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (new URL(url).pathname === `/dp/${bookAsin}`) return productResponse();
    return waitForAbort(options.signal);
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 200);
  t.after(() => clearTimeout(timeout));
  const result = await settleSnapshot(book.asin, book, {
    signal: controller.signal, seriesPriceTimeoutMs: 25, timeoutMs: 1000,
    seriesCandidateCache: new Map(), store: { books: [book] }
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.snapshot.currentPrice, 500);
  assert.equal(result.snapshot.provider, 'amazon_html');
  assert.equal(controller.signal.aborted, false);
  assert.ok(requests.some(url => new URL(url).pathname === `/dp/${bookAsin}`));
});

test('failed series price lookups back off briefly, recover after expiry and can use full discovery results', async t => {
  let seriesRequests = 0;
  installMockFetch(t, async (url, options) => {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (new URL(url).pathname === `/dp/${bookAsin}`) return productResponse();
    if (String(url).includes(sourceAsin)) seriesRequests += 1;
    return new Response('unavailable', { status: 404 });
  });
  const seriesCandidateCache = new Map();
  const acquisitionStats = {
    seriesLookupMs: 0, individualLookupMs: 0,
    seriesPriceHits: 0, individualPriceHits: 0, seriesFailureCacheSkips: 0
  };
  const options = { seriesCandidateCache, acquisitionStats, store: { books: [book] }, seriesPriceTimeoutMs: 100 };
  assert.equal((await settleSnapshot(book.asin, book, options)).ok, true);
  const firstRequestCount = seriesRequests;
  assert.ok(firstRequestCount > 0);
  assert.equal((await settleSnapshot(book.asin, book, options)).ok, true);
  assert.equal(seriesRequests, firstRequestCount);
  assert.equal(acquisitionStats.seriesFailureCacheSkips, 1);
  assert.equal(acquisitionStats.individualPriceHits, 2);

  const [failureKey, failure] = [...seriesCandidateCache].find(([key]) => key.startsWith('failure:price-series:'));
  failure.retryAt = Date.now() - 1;
  assert.equal((await settleSnapshot(book.asin, book, options)).ok, true);
  assert.ok(seriesRequests > firstRequestCount);

  seriesCandidateCache.set(failureKey.replace(/^failure:price-/, ''), {
    seriesName: book.seriesName, items: [
      { asin: bookAsin, title: book.title, currentPrice: 500, currentPoints: 0, provider: 'amazon_series_child' },
      { asin: 'B074333333', title: 'Runtime Series 2', currentPrice: 500, currentPoints: 0, provider: 'amazon_series_child' }
    ]
  });
  assert.equal(canUseCachedSeriesPriceSnapshotForBook(book, options), true);
  const recovered = await settleSnapshot(book.asin, book, options);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.snapshot.provider, 'amazon_series_child');
  assert.equal(acquisitionStats.seriesPriceHits, 1);
});

test('reducing the book allowance also caps the preliminary series allowance', async t => {
  installMockFetch(t, async (url, options) => {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (new URL(url).pathname === `/dp/${bookAsin}`) return productResponse();
    return waitForAbort(options.signal);
  });
  process.env.CHECK_BOOK_MAX_RUNTIME_MS = '1000';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  t.after(() => clearTimeout(timer));
  const result = await settleSnapshot(book.asin, book, {
    signal: controller.signal, seriesPriceTimeoutMs: 15000,
    seriesCandidateCache: new Map(), store: { books: [book] }
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(controller.signal.aborted, false);
});

test('pricing a series does not perform completion probes or pollute the discovery cache', async t => {
  const requests = [];
  installMockFetch(t, async url => {
    requests.push(String(url));
    return new Response(`<meta property="og:title" content="Runtime Series (全2巻)">
      <div id="series-childAsin-list">
        <div id="series-childAsin-item_0" data-asin="${bookAsin}">
          <a href="/dp/${bookAsin}" title="Runtime Series 1">Runtime Series 1</a>
          <span class="a-color-price">￥500</span>
        </div>
        <div id="series-childAsin-item_1" data-asin="B074333333">
          <a href="/dp/B074333333" title="Runtime Series 2">Runtime Series 2</a>
          <span class="a-color-price">￥500</span>
        </div>
      </div>`, { status: 200 });
  });
  const seriesCandidateCache = new Map();
  const options = { seriesCandidateCache, store: { books: [book] } };
  const first = await settleSnapshot(book.asin, book, options);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.snapshot.provider, 'amazon_series_child');
  const priceKey = [...seriesCandidateCache.keys()].find(key => key.startsWith('price-series:'));
  assert.ok(priceKey);
  assert.equal(seriesCandidateCache.has(priceKey.replace(/^price-/, '')), false);
  assert.equal(requests.length, 1);
  assert.equal(canUseCachedSeriesPriceSnapshotForBook(book, options), true);
  assert.equal((await settleSnapshot(book.asin, book, options)).ok, true);
  assert.equal(requests.length, 1);
});

test('cancelling a book check stops fallback requests and retry waits', async t => {
  let requests = 0;
  installMockFetch(t, async () => { requests += 1; throw new Error('unexpected fetch'); });
  const controller = new AbortController();
  controller.abort();
  const result = await settleSnapshot(book.asin, book, {
    signal: controller.signal, seriesCandidateCache: new Map(), store: { books: [book] }
  });
  assert.equal(result.ok, false);
  assert.equal(requests, 0);
});

test('standalone listasIn provider honours the book cancellation signal', async t => {
  let requests = 0;
  installMockFetch(t, async (url, options) => {
    requests += 1;
    assert.equal(new URL(url).hostname, 'www.listasin.net');
    return waitForAbort(options.signal);
  });
  process.env.PRICE_PROVIDER = 'listasin';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  t.after(() => clearTimeout(timer));
  const result = await settleSnapshot(book.asin, { ...book, importMode: 'single', seriesKey: '' }, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(requests, 1);
});

test('a complete isolated run records timing diagnostics and preserves settings and notifications', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kpw-runtime-test-'));
  const checkerUrl = new URL('../src/checker.mjs', import.meta.url).href;
  const notification = { id: 'existing-notification', type: 'price_drop', status: 'sent', bookId: 'other-book' };
  try {
    await mkdir(path.join(cwd, 'data'));
    await writeFile(path.join(cwd, 'data/store.json'), JSON.stringify({
      books: [book], settings: { batchSize: 1, notificationThreshold: 80 },
      priceHistory: [], seriesPriceHistory: [], notifications: [notification]
    }));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      globalThis.fetch = async () => new Response(${JSON.stringify(await productResponse().text())}, { status: 200 });
      const { runDueChecks } = await import(${JSON.stringify(checkerUrl)});
      const result = await runDueChecks({
        source: 'manual', force: true, notify: false, discoverSeries: false,
        discoverCheckedSeries: false, importQueue: false, singleSeriesAudit: false,
        listPriceChallenge: false, priceIntegrityAudit: false
      });
      console.log(JSON.stringify(result));
    `], {
      cwd, encoding: 'utf8', timeout: 10000,
      env: {
        ...process.env, BLOB_READ_WRITE_TOKEN: '', KPW_RUNTIME_ENV_FILE: '',
        PRICE_PROVIDER: 'amazon_html', SERIES_PRICE_CHECK_FIRST: 'false',
        CHECK_MAX_RUNTIME_MS: '0', CHECK_REQUEST_DELAY_MS: '0', CHECK_REQUEST_JITTER_MS: '0',
        HTTP_REQUEST_MIN_INTERVAL_MS: '0', HTTP_REQUEST_JITTER_MS: '0'
      }
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.checked, 1);
    assert.equal(result.results[0].ok, true);
    assert.equal(result.priceAcquisition.individualPriceHits, 1);
    for (const phase of ['setupMs', 'bookChecksMs', 'persistenceMs', 'summaryNotificationMs', 'totalMs']) {
      assert.ok(Number.isFinite(result.timings[phase]), phase);
    }
    const saved = JSON.parse(await readFile(path.join(cwd, 'data/store.json'), 'utf8'));
    assert.equal(saved.settings.notificationThreshold, 80);
    assert.equal(saved.books.length, 1);
    assert.ok(saved.notifications.some(entry => entry.id === notification.id && entry.status === 'sent'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
