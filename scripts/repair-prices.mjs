import { existsSync, readFileSync } from 'node:fs';
import { loadEnv } from '../src/env.mjs';
import { checkBookById } from '../src/checker.mjs';
import { readStore } from '../src/store.mjs';

loadEnvFile('.env.production.local');
loadEnv();

const options = parseArgs(process.argv.slice(2));
const store = await readStore();
const books = selectBooks(store.books, options);

if (options.dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    selected: books.length,
    books: books.map(summaryBook)
  }, null, 2));
  process.exit(0);
}

const results = [];
let cursor = 0;
const concurrency = Math.min(options.concurrency, Math.max(books.length, 1));

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const book = books[index];
      if (!book) return;

      try {
        const result = await checkBookById(book.id, { notify: false, updateCursor: false });
        results.push({
          ok: result.ok,
          asin: book.asin,
          title: book.title,
          before: {
            price: book.currentPrice,
            points: book.currentPoints,
            effectivePrice: book.effectivePrice,
            lowestPrice: book.lowestPrice,
            lowestEffectivePrice: book.lowestEffectivePrice,
            provider: book.provider
          },
          after: result.book
            ? {
                price: result.book.currentPrice,
                points: result.book.currentPoints,
                effectivePrice: result.book.effectivePrice,
                lowestPrice: result.book.lowestPrice,
                lowestEffectivePrice: result.book.lowestEffectivePrice,
                provider: result.book.provider,
                lastError: result.book.lastError
              }
            : null,
          error: result.error || ''
        });
      } catch (error) {
        results.push({
          ok: false,
          asin: book.asin,
          title: book.title,
          error: error.message || String(error)
        });
      }
    }
  })
);

console.log(JSON.stringify({
  dryRun: false,
  selected: books.length,
  checked: results.length,
  updated: results.filter((result) => priceChanged(result)).length,
  failed: results.filter((result) => !result.ok).length,
  results: results.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ja'))
}, null, 2));

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseArgs(args) {
  const options = {
    all: false,
    dryRun: false,
    legacy: false,
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
    else if (arg === '--legacy') options.legacy = true;
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
  return options;
}

function selectBooks(books, options) {
  const selected = books.filter((book) => {
    if (options.all) return true;
    if (options.asins.includes(String(book.asin || '').toUpperCase())) return true;
    if (options.legacy && book.provider === 'legacy_provider_removed') return true;
    if (options.providers.includes(book.provider)) return true;
    if (options.series.some((name) => String(book.seriesName || book.title || '').includes(name))) return true;
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
  if (!Number.isFinite(price) || price <= 0) return false;

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
