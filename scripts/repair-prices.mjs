import { loadEnv, loadEnvFile } from '../src/env.mjs';
import { repairBookPricesByAsins } from '../src/checker.mjs';
import { readStore } from '../src/store.mjs';
import { registerStorePayloadSync } from '../src/store-payload-sync.mjs';

loadEnvFile('.env.production.local');
loadEnv();
registerStorePayloadSync();

const options = parseArgs(process.argv.slice(2));
const store = await readStore();
const books = selectBooks(store.books, options);

if (options.dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    selected: books.length,
    books: options.summaryOnly ? undefined : books.map(summaryBook)
  }, null, 2));
  process.exit(0);
}

if (books.length === 0) {
  console.log(JSON.stringify({
    dryRun: false,
    selected: 0,
    checked: 0,
    updated: 0,
    failed: 0,
    results: []
  }, null, 2));
  process.exit(0);
}

const beforeByAsin = new Map(books.map((book) => [book.asin, summaryBook(book)]));
const progress = progressReporter(books.length, options);
let repair;
try {
  repair = await repairBookPricesByAsins(books.map((book) => book.asin), {
    notify: false,
    concurrency: options.concurrency,
    maxAsins: Math.max(books.length, 30),
    onProgress: progress,
    timeoutMs: options.timeoutMs,
    seriesPriceFirst: options.seriesPriceFirst,
    abortFailureRate: options.abortFailureRate,
    abortFailureMinimum: options.abortFailureMinimum
  });
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    selected: books.length,
    error: error.message,
    code: error.code || '',
    abortSummary: error.abortSummary || null
  }, null, 2));
  process.exit(1);
}
const results = repair.results.map((result) => {
  const before = beforeByAsin.get(result.asin);
  return {
    ok: result.ok,
    asin: result.asin,
    title: before?.title || result.book?.title || '',
    before: before ? priceSummary(before) : null,
    after: result.book ? priceSummary(result.book) : null,
    error: result.error || ''
  };
});

console.log(JSON.stringify({
  dryRun: false,
  selected: books.length,
  checked: results.length,
  updated: results.filter((result) => priceChanged(result)).length,
  failed: results.filter((result) => !result.ok).length,
  results: options.summaryOnly ? undefined : results.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ja'))
}, null, 2));

function parseArgs(args) {
  const options = {
    all: false,
    dryRun: false,
    progress: false,
    summaryOnly: false,
    abortFailureRate: null,
    abortFailureMinimum: 10,
    timeoutMs: null,
    seriesPriceFirst: true,
    limit: 500,
    concurrency: 1,
    asins: [],
    series: [],
    providers: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--all') options.all = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--progress') options.progress = true;
    else if (arg === '--summary-only') options.summaryOnly = true;
    else if (arg === '--no-series-price-first') options.seriesPriceFirst = false;
    else if (arg === '--no-abort-failure-rate') options.abortFailureRate = null;
    else if (arg.startsWith('--abort-failure-rate=')) options.abortFailureRate = fraction(arg.slice(21), options.abortFailureRate);
    else if (arg === '--abort-failure-rate') options.abortFailureRate = fraction(args[++index], options.abortFailureRate);
    else if (arg.startsWith('--abort-failure-minimum=')) options.abortFailureMinimum = positiveInteger(arg.slice(24), options.abortFailureMinimum);
    else if (arg === '--abort-failure-minimum') options.abortFailureMinimum = positiveInteger(args[++index], options.abortFailureMinimum);
    else if (arg.startsWith('--timeout-ms=')) options.timeoutMs = positiveInteger(arg.slice(13), options.timeoutMs);
    else if (arg === '--timeout-ms') options.timeoutMs = positiveInteger(args[++index], options.timeoutMs);
    else if (arg.startsWith('--limit=')) options.limit = positiveInteger(arg.slice(8), options.limit);
    else if (arg === '--limit') options.limit = positiveInteger(args[++index], options.limit);
    else if (arg.startsWith('--concurrency=')) options.concurrency = positiveInteger(arg.slice(14), options.concurrency);
    else if (arg === '--concurrency') options.concurrency = positiveInteger(args[++index], options.concurrency);
    else if (arg.startsWith('--series=')) options.series.push(arg.slice(9));
    else if (arg === '--series') options.series.push(args[++index] || '');
    else if (arg.startsWith('--asin=')) options.asins.push(...arg.slice(7).split(','));
    else if (arg === '--asin') options.asins.push(...String(args[++index] || '').split(','));
    else if (arg.startsWith('--provider=')) options.providers.push(...arg.slice(11).split(','));
    else if (arg === '--provider') options.providers.push(...String(args[++index] || '').split(','));
  }

  options.series = options.series.map((value) => value.trim()).filter(Boolean);
  options.asins = options.asins.map((value) => value.trim().toUpperCase()).filter(Boolean);
  options.providers = options.providers.map((value) => value.trim()).filter(Boolean);
  if (options.all && options.abortFailureRate == null) options.abortFailureRate = 0.25;
  if (options.all && options.timeoutMs == null) options.timeoutMs = 120000;
  return options;
}

function selectBooks(books, options) {
  const hasExplicitFilters = Boolean(
    options.asins.length ||
    options.series.length ||
    options.providers.length
  );
  const selected = books.filter((book) => {
    if (options.all) return true;
    if (options.asins.includes(String(book.asin || '').toUpperCase())) return true;
    if (options.providers.includes(book.provider)) return true;
    if (options.series.some((name) => String(book.seriesName || book.title || '').includes(name))) return true;
    if (hasExplicitFilters) return false;
    return isRepairCandidate(book);
  });
  return selected.slice(0, options.limit);
}

function isRepairCandidate(book) {
  return (
    suspiciousStoredPrice(book) ||
    suspiciousStoredFloor(book)
  );
}

function suspiciousStoredPrice(book) {
  const price = Number(book.currentPrice);
  if (!Number.isFinite(price)) return false;
  const reference = Math.max(
    ...[book.previousEffectivePrice, book.lowestPrice, book.lowestEffectivePrice, book.listPrice]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  if (
    price >= 0 &&
    price <= 5 &&
    ['amazon_html', 'amazon_search'].includes(String(book.provider || '').toLowerCase()) &&
    Number.isFinite(reference) &&
    reference >= 100
  ) {
    return true;
  }
  if (price <= 0) return false;

  const points = Number(book.currentPoints || 0);
  if (Number.isFinite(points) && points > price) return true;

  const listPrice = Number(book.listPrice);
  if (
    Number.isFinite(points) &&
    points > 0 &&
    Number.isFinite(listPrice) &&
    listPrice >= 1000 &&
    price <= listPrice * 0.15 &&
    points / price >= 0.2
  ) {
    return true;
  }

  return Number.isFinite(listPrice) && listPrice > 0 && price > listPrice * 1.15;
}

function suspiciousStoredFloor(book) {
  const floor = Number(book.lowestPrice);
  if (!Number.isFinite(floor) || floor <= 0) return false;
  const listPrice = Number(book.listPrice);
  return Number.isFinite(listPrice) && listPrice > 0 && floor > listPrice * 1.15;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function fraction(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 1) return fallback;
  return number;
}

function summaryBook(book) {
  return {
    asin: book.asin,
    title: book.title,
    seriesName: book.seriesName,
    volume: book.volume,
    currentPrice: book.currentPrice,
    currentPoints: book.currentPoints,
    effectivePrice: book.effectivePrice,
    lowestPrice: book.lowestPrice,
    lowestEffectivePrice: book.lowestEffectivePrice,
    listPrice: book.listPrice,
    provider: book.provider,
    lastError: book.lastError
  };
}

function priceSummary(book) {
  return {
    price: book.currentPrice,
    points: book.currentPoints,
    effectivePrice: book.effectivePrice,
    lowestPrice: book.lowestPrice,
    lowestEffectivePrice: book.lowestEffectivePrice,
    provider: book.provider,
    lastError: book.lastError
  };
}

function priceChanged(result) {
  if (!result.before || !result.after) return false;
  return (
    result.before.price !== result.after.price ||
    result.before.points !== result.after.points ||
    result.before.effectivePrice !== result.after.effectivePrice ||
    result.before.lowestPrice !== result.after.lowestPrice ||
    result.before.lowestEffectivePrice !== result.after.lowestEffectivePrice ||
    result.before.provider !== result.after.provider
  );
}

function progressReporter(total, options) {
  if (!options.progress) return null;
  let done = 0;
  let failed = 0;
  let nextReportAt = Date.now();
  const start = Date.now();

  return (event) => {
    done += 1;
    if (!event.ok) failed += 1;
    const now = Date.now();
    const shouldReport = done === total || done === 1 || done % 10 === 0 || now >= nextReportAt;
    if (!shouldReport) return;
    nextReportAt = now + 30_000;
    const percent = total > 0 ? Math.round((done / total) * 1000) / 10 : 100;
    const elapsedSec = Math.round((now - start) / 1000);
    const rate = elapsedSec > 0 ? done / elapsedSec : 0;
    const etaSec = rate > 0 ? Math.round((total - done) / rate) : null;
    console.error(JSON.stringify({
      progress: true,
      done,
      total,
      percent,
      failed,
      elapsedSec,
      etaSec
    }));
  };
}
