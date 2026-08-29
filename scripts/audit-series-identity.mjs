import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { loadEnv } from '../src/env.mjs';
import { amazonUrlForAsin } from '../src/amazon-url.mjs';
import { fetchKindleSeriesItems } from '../src/price-provider.mjs';
import { seriesCandidatesAreCompatible } from '../src/series-identity.mjs';
import { auditStoreAgainstReference, restoreSeriesGroupsFromReference } from '../src/store-reference-audit.mjs';
import { readStoreWithMetadata, updateStore } from '../src/store.mjs';

loadEnv();

const referencePath = path.resolve(process.cwd(), optionValue('--reference') || 'data/store.json');
const repairKeys = optionValues('--repair');
let referenceStore = JSON.parse(await readFile(referencePath, 'utf8'));
const before = await readStoreWithMetadata({ force: true });
const audit = auditStoreAgainstReference(before.store, referenceStore);

if (repairKeys.length === 0) {
  console.log(JSON.stringify({ mode: 'audit', etag: before.etag, ...audit }, null, 2));
  process.exit(0);
}

if (hasFlag('--refresh')) {
  referenceStore = await refreshReferenceSeriesPrices(referenceStore, repairKeys);
}

let repair;
await updateStore((store) => {
  repair = restoreSeriesGroupsFromReference(store, referenceStore, repairKeys);
  return store;
});

const after = await readStoreWithMetadata({ force: true });
console.log(JSON.stringify({
  mode: 'repair',
  beforeEtag: before.etag,
  afterEtag: after.etag,
  repair,
  audit: auditStoreAgainstReference(after.store, referenceStore)
}, null, 2));

function optionValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

function optionValues(name) {
  const values = [];
  const prefix = `${name}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length));
    if (arg === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

async function refreshReferenceSeriesPrices(reference, seriesKeys) {
  const refreshed = structuredClone(reference);
  const now = new Date().toISOString();

  for (const seriesKey of seriesKeys) {
    const sourceAsin = String(seriesKey).match(/^series:asin:([A-Z0-9]{10})$/i)?.[1]?.toUpperCase();
    if (!sourceAsin) throw new Error(`Cannot refresh a series without a source ASIN: ${seriesKey}`);

    const books = refreshed.books.filter((book) => (book.seriesKey || book.sourceUrl) === seriesKey);
    if (books.length === 0) throw new Error(`Reference series was not found: ${seriesKey}`);
    const seriesName = books[0].seriesName || '';
    const series = await fetchKindleSeriesItems(amazonUrlForAsin(sourceAsin), {
      allowReaderFallback: false,
      probeSeriesCompletion: false
    });
    if (!seriesCandidatesAreCompatible({ seriesName, items: books }, series)) {
      throw new Error(`Refreshed Amazon series does not match ${seriesName}: ${series.seriesName || 'unknown'}`);
    }

    const itemsByAsin = new Map((series.items || []).map((item) => [String(item.asin || '').toUpperCase(), item]));
    for (const book of books) {
      const item = itemsByAsin.get(String(book.asin || '').toUpperCase());
      if (!item) throw new Error(`Refreshed Amazon series is missing ${book.asin}: ${seriesName}`);
      if (item.imageUrl) {
        book.imageUrl = item.imageUrl;
        book.imageSource = item.imageSource || item.provider || '';
      }
      if (item.releaseDate) book.releaseDate = item.releaseDate;
      if (item.currentPrice != null && Number.isFinite(Number(item.currentPrice))) {
        const previousEffectivePrice = book.effectivePrice ?? null;
        book.previousEffectivePrice = previousEffectivePrice;
        book.currentPrice = Number(item.currentPrice);
        book.currentPoints = Number(item.currentPoints || 0);
        book.effectivePrice = Number.isFinite(Number(item.effectivePrice))
          ? Number(item.effectivePrice)
          : Math.max(0, book.currentPrice - book.currentPoints);
        book.lowestPrice = minimumNullable(book.lowestPrice, book.currentPrice);
        book.lowestEffectivePrice = minimumNullable(book.lowestEffectivePrice, book.effectivePrice);
        book.provider = item.provider || book.provider;
        book.lastCheckedAt = now;
        book.lastError = '';
        refreshed.priceHistory ||= [];
        refreshed.priceHistory.push({
          id: crypto.randomUUID(),
          bookId: book.id,
          asin: book.asin,
          price: book.currentPrice,
          points: book.currentPoints,
          effectivePrice: book.effectivePrice,
          listPrice: book.listPrice ?? null,
          provider: book.provider,
          checkedAt: now
        });
      }
    }
  }

  return refreshed;
}

function minimumNullable(left, right) {
  const values = [left, right]
    .filter((value) => value != null && value !== '')
    .map(Number)
    .filter(Number.isFinite);
  return values.length > 0 ? Math.min(...values) : null;
}
