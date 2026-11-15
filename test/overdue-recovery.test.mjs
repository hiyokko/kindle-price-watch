import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function book(id, asin, hours, extra = {}) {
  return {
    id, asin, title: `Recovery ${id}`, currentPrice: 500, effectivePrice: 500,
    currentPoints: 0, provider: 'amazon_html', imageUrl: 'https://example.test/cover.jpg',
    createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    lastCheckedAt: new Date(Date.now() - hours * 3600000).toISOString(), ...extra
  };
}

async function runFixture(books, { failingAsins = [], recover = false, blocked = false, discover = false, exhaustRuntime = false, env = {} } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kpw-overdue-test-'));
  const notification = { id: 'sent-notification', type: 'price_drop', status: 'sent', bookId: 'other-book' };
  try {
    await mkdir(path.join(cwd, 'data'));
    await writeFile(path.join(cwd, 'data/store.json'), JSON.stringify({
      books, settings: { batchSize: books.length, notificationThreshold: 80 },
      priceHistory: [], seriesPriceHistory: [], notifications: [notification]
    }));
    const checkerUrl = new URL('../src/checker.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const calls = [], counts = new Map(), failing = new Set(${JSON.stringify(failingAsins)});
      const realNow = Date.now;
      let clockOffset = 0;
      Date.now = () => realNow() + clockOffset;
      globalThis.fetch = async url => {
        const parsed = new URL(url);
        const asin = parsed.pathname.match(/\\/dp\\/([A-Z0-9]{10})/)?.[1];
        if (parsed.hostname === 'www.amazon.co.jp' && asin) {
          calls.push(asin);
          counts.set(asin, (counts.get(asin) || 0) + 1);
          if (${blocked} && failing.has(asin)) return new Response('blocked', { status: 403 });
          const missing = failing.has(asin) && (!${recover} || counts.get(asin) <= 2);
          if (missing && ${exhaustRuntime}) clockOffset = 120000;
          return new Response('<span id="productTitle">Recovery ' +
            ${JSON.stringify(Object.fromEntries(books.map(b => [b.asin, b.id])))}[asin] +
            '</span><div id="tmm-grid-swatch-KINDLE">Kindle版</div>' +
            (missing ? '' : '<span class="a-color-price">￥500</span>'), { status: 200 });
        }
        if (parsed.hostname === 'www.listasin.net') return new Response('{"result":{"books":{}}}', { status: 200 });
        return new Response('not found', { status: 404 });
      };
      const { runDueChecks } = await import(${JSON.stringify(checkerUrl)});
      const result = await runDueChecks({ source: 'manual', notify: false, force: true,
        discoverSeries: false, discoverCheckedSeries: ${discover}, importQueue: false,
        singleSeriesAudit: false, listPriceChallenge: false, priceIntegrityAudit: false });
      console.log(JSON.stringify({ result, calls }));
    `], {
      cwd, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, BLOB_READ_WRITE_TOKEN: '', KPW_RUNTIME_ENV_FILE: '',
        PRICE_PROVIDER: 'amazon_html', SERIES_PRICE_CHECK_FIRST: 'false',
        AMAZON_READER_FALLBACK: 'false', HTTP_AMAZON_FETCH_RETRIES: '0', JSON_FETCH_RETRIES: '0',
        CHECK_OVERDUE_HOURS: '24', CHECK_OVERDUE_RETRY_LIMIT: '10',
        CHECK_OVERDUE_RETRY_MAX_RUNTIME_MS: '300000', CHECK_OVERDUE_RETRY_BOOK_MAX_RUNTIME_MS: '30000',
        CHECK_MAX_RUNTIME_MS: '0', CHECK_REQUEST_DELAY_MS: '0', CHECK_REQUEST_JITTER_MS: '0',
        CHECK_BLOCK_COOLDOWN_MS: '0', CHECK_TRANSIENT_ERROR_COOLDOWN_MS: '0',
        HTTP_REQUEST_MIN_INTERVAL_MS: '0', HTTP_REQUEST_JITTER_MS: '0', HTTP_BLOCK_COOLDOWN_MS: '0', ...env }
    });
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout);
    const saved = JSON.parse(await readFile(path.join(cwd, 'data/store.json'), 'utf8'));
    assert.equal(saved.books.length, books.length);
    assert.equal(saved.settings.notificationThreshold, 80);
    assert.ok(saved.notifications.some(entry => entry.id === notification.id && entry.status === 'sent'));
    return { ...output, saved };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test('an old failure gets one retry after the other old books and before fresher books', async () => {
  const books = [book('young', 'B074444443', 2), book('oldest', 'B074444441', 96), book('old', 'B074444442', 48)];
  const { result, calls, saved } = await runFixture(books, { failingAsins: ['B074444441'], recover: true });
  assert.equal(result.checked, 3);
  assert.equal(result.overdueRetries.attempted, 1);
  assert.equal(result.overdueRetries.succeeded, 1);
  assert.equal(result.checkPlan.overdueSucceeded, 2);
  assert.deepEqual(calls, ['B074444441', 'B074444441', 'B074444442', 'B074444441', 'B074444443']);
  assert.ok(saved.books.every(entry => !entry.lastCheckAttemptError));
});

test('failed acquisition never makes an old successful price look freshly checked', async () => {
  const oldest = book('oldest', 'B074444441', 96);
  const { result, calls, saved } = await runFixture([oldest], { failingAsins: [oldest.asin] });
  assert.equal(result.overdueRetries.attempted, 1);
  assert.equal(result.overdueRetries.failed, 1);
  assert.equal(calls.length, 4);
  assert.equal(saved.books[0].lastCheckedAt, oldest.lastCheckedAt);
  assert.equal(saved.books[0].currentPrice, oldest.currentPrice);
  assert.ok(Date.parse(saved.books[0].lastCheckAttemptedAt) > Date.parse(oldest.lastCheckedAt));
  assert.equal(saved.books[0].lastCheckAttemptError, '価格を取得できませんでした');
});

test('blocked old books retain age and do not get an immediate network retry', async () => {
  const oldest = book('oldest', 'B074444441', 96);
  const { result, calls, saved } = await runFixture([oldest], { failingAsins: [oldest.asin], blocked: true });
  assert.equal(result.overdueRetries.attempted, 0);
  assert.equal(calls.length, 1);
  assert.equal(saved.books[0].lastCheckedAt, oldest.lastCheckedAt);
  assert.match(saved.books[0].lastCheckAttemptError, /HTTP 403/);
});

test('overdue retry limits and budgets leave failed books pending without looping', async () => {
  const books = [book('oldest', 'B074444441', 96), book('old', 'B074444442', 48)];
  const limited = await runFixture(books, { failingAsins: books.map(b => b.asin), env: { CHECK_OVERDUE_RETRY_LIMIT: '1' } });
  assert.equal(limited.result.overdueRetries.eligible, 2);
  assert.equal(limited.result.overdueRetries.attempted, 1);
  assert.equal(limited.result.overdueRetries.skipped, 1);
  const noTime = await runFixture(books, { failingAsins: books.map(b => b.asin), env: { CHECK_OVERDUE_RETRY_MAX_RUNTIME_MS: '0' } });
  assert.equal(noTime.result.overdueRetries.attempted, 0);
  assert.equal(noTime.calls.length, 4);
});

test('per-book discovery waits until all selected old books have had their price checks', async () => {
  const sourceAsin = 'B074444449';
  const series = { seriesName: 'Recovery', seriesKey: `series:asin:${sourceAsin}`,
    sourceUrl: `https://www.amazon.co.jp/dp/${sourceAsin}`, importMode: 'kindle_series', seriesExpectedCount: 2 };
  const books = [book('oldest', 'B074444441', 96, series), book('old', 'B074444442', 48)];
  const { calls, result } = await runFixture(books, { discover: true });
  assert.deepEqual(calls.slice(0, 2), books.map(b => b.asin));
  assert.ok(calls.indexOf(sourceAsin) >= 2);
  assert.equal(result.checkPlan.overdueSucceeded, 2);
});

test('recovery does not consume the global save reserve after runtime exhaustion', async () => {
  const books = [book('oldest', 'B074444441', 96), book('old', 'B074444442', 48)];
  const { result, saved } = await runFixture(books, {
    failingAsins: [books[0].asin], exhaustRuntime: true,
    env: { CHECK_MAX_RUNTIME_MS: '120000', CHECK_SAVE_RESERVE_MS: '60000', CHECK_MIN_BOOK_RUNTIME_MS: '1000' }
  });
  assert.equal(result.checked, 1);
  assert.equal(result.stoppedByRuntimeLimit, true);
  assert.equal(result.overdueRetries.attempted, 0);
  assert.equal(saved.books[0].lastCheckedAt, books[0].lastCheckedAt);
});
