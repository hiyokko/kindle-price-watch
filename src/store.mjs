import { promises as fs } from 'node:fs';
import path from 'node:path';
import { amazonUrlForAsin } from './price-provider.mjs';

const dataDir = path.join(process.cwd(), 'data');
const storePath = path.join(dataDir, 'store.json');
const blobStorePath = process.env.BLOB_STORE_PATH || 'kindle-price-watch/store.json';
const amazonImagePrefix = 'https://m.media-amazon.com/images/I/';

const defaultStore = {
  version: 1,
  settings: {
    notificationThreshold: 10,
    checkRunsPerDay: 2,
    checkIntervalHours: 24,
    checkExecutionHourJst: 3,
    checkExecutionMinuteJst: 54,
    secondCheckExecutionHourJst: 15,
    secondCheckExecutionMinuteJst: 54,
    batchSize: 50,
    notifyOnPriceDrop: true,
    notifyOnBestEver: true,
    discordWebhookUrls: null
  },
  books: [],
  priceHistory: [],
  seriesPriceHistory: [],
  notifications: [],
  automation: {
    lastCronStartedAt: '',
    lastCronFinishedAt: '',
    lastCronExecutionBoundaryAt: '',
    lastCronSchedule: '',
    lastCronBackup: false,
    lastCronChecked: 0,
    lastCronRemainingDue: 0,
    lastCronStoppedByRuntimeLimit: false,
    lastCronError: '',
    lastImportQueueProcessed: 0,
    lastImportQueueImported: 0,
    lastImportQueueErrors: 0,
    lastSeriesDiscoveryChecked: 0,
    lastSeriesDiscoveryAdded: 0,
    lastSeriesDiscoveryCompleted: 0,
    lastSeriesDiscoverySkipped: 0,
    lastSeriesDiscoveryErrors: 0
  },
  checkCursor: {
    lastBookId: '',
    lastAsin: '',
    lastTitle: '',
    checkedAt: ''
  },
  seriesDiscoveryCursor: {
    lastSeriesKey: '',
    checkedAt: ''
  },
  importQueue: {
    pending: [],
    completed: [],
    errors: []
  }
};

let writeQueue = Promise.resolve();
let blobSdkPromise;
let blobStoreCache = {
  expiresAt: 0,
  metadata: null,
  promise: null
};

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify(defaultStore, null, 2));
  }
}

function mergeStore(store) {
  return {
    ...defaultStore,
    ...store,
    settings: mergeSettings(store.settings),
    books: Array.isArray(store.books) ? store.books.map(normalizeBook) : [],
    priceHistory: Array.isArray(store.priceHistory) ? store.priceHistory : [],
    seriesPriceHistory: Array.isArray(store.seriesPriceHistory) ? store.seriesPriceHistory : [],
    notifications: Array.isArray(store.notifications) ? store.notifications : [],
    automation: normalizeAutomation(store.automation),
    checkCursor: normalizeCheckCursor(store.checkCursor),
    seriesDiscoveryCursor: normalizeSeriesDiscoveryCursor(store.seriesDiscoveryCursor),
    importQueue: normalizeImportQueue(store.importQueue)
  };
}

function mergeSettings(settings = {}) {
  const merged = {
    ...defaultStore.settings,
    ...(settings || {})
  };

  merged.checkRunsPerDay = 2;
  merged.checkIntervalHours = 24;
  merged.checkExecutionHourJst = 3;
  merged.checkExecutionMinuteJst = 54;
  merged.secondCheckExecutionHourJst = 15;
  merged.secondCheckExecutionMinuteJst = 54;

  return merged;
}

export async function readStore() {
  if (hasBlobConfig()) {
    return readBlobStore();
  }

  await ensureStore();
  const raw = await fs.readFile(storePath, 'utf8');
  return mergeStore(JSON.parse(raw));
}

export async function updateStore(mutator) {
  if (hasBlobConfig()) {
    return updateBlobStore(mutator);
  }

  writeQueue = writeQueue.then(async () => {
    const store = await readStore();
    const next = mergeStoreMutationResult(await mutator(store));
    const tmpPath = `${storePath}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2));
    await fs.rename(tmpPath, storePath);
    return next;
  });

  return writeQueue;
}

export function publicBook(book) {
  const listPrice = publicListPrice(book);
  return {
    id: book.id,
    asin: book.asin,
    title: book.title,
    author: publicMetadataText(book.author),
    publisher: publicMetadataText(book.publisher),
    seriesKey: book.seriesKey || '',
    seriesName: book.seriesName,
    volume: book.volume,
    seriesExpectedCount: book.seriesExpectedCount || '',
    sourceUrl: book.sourceUrl || '',
    importMode: book.importMode || 'single',
    imageUrl: book.imageUrl || amazonImageUrlForKey(book.imageKey),
    amazonUrl: book.amazonUrl || amazonUrlForAsin(book.asin),
    currentPrice: book.currentPrice,
    currentPoints: book.currentPoints,
    effectivePrice: book.effectivePrice,
    listPrice,
    discountRate: discountRate(book.effectivePrice, listPrice),
    lowestPrice: book.lowestPrice,
    lowestEffectivePrice: book.lowestEffectivePrice,
    previousEffectivePrice: book.previousEffectivePrice,
    lastCheckedAt: book.lastCheckedAt,
    seriesCompleted: Boolean(book.seriesCompleted),
    seriesCompletedAt: book.seriesCompletedAt || '',
    seriesLastDiscoveredAt: book.seriesLastDiscoveredAt || '',
    seriesDiscoveryStatus: book.seriesDiscoveryStatus || '',
    seriesDiscoverySkipReason: book.seriesDiscoverySkipReason || '',
    seriesDiscoverySkippedAt: book.seriesDiscoverySkippedAt || '',
    seriesDiscoveryError: book.seriesDiscoveryError || '',
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    lastError: book.lastError,
    provider: book.provider
  };
}

function publicListPrice(book) {
  if (!book || isSeriesDerivedPriceProvider(book.provider)) return null;
  return book.listPrice;
}

function isSeriesDerivedPriceProvider(provider) {
  const normalized = String(provider || '').toLowerCase();
  return normalized.includes('_series') || normalized === 'amazon_series_bulk' || normalized === 'amazon_series_reader';
}

function discountRate(effectivePrice, listPrice) {
  const effective = Number(effectivePrice);
  const list = Number(listPrice);
  if (!Number.isFinite(effective) || !Number.isFinite(list) || list <= 0) return null;
  return Math.max(0, Math.round(((list - effective) / list) * 100));
}

function normalizeBook(book) {
  const asin = String(book?.asin || '').trim().toUpperCase();
  const imageUrl = book?.imageUrl || amazonImageUrlForKey(book?.imageKey);
  return {
    ...book,
    asin: asin || book?.asin,
    imageUrl,
    imageSource: book?.imageSource || '',
    amazonUrl: book?.amazonUrl || (asin ? amazonUrlForAsin(asin) : ''),
    currentPoints: Number(book?.currentPoints || 0),
    importMode: book?.importMode || 'single'
  };
}

function publicMetadataText(value) {
  const text = String(value || '')
    .replace(/^フォロー,\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length > 120) return '';
  if (/function|P\.when|A\.declarative|window\.ue|var\s+/i.test(text)) return '';
  return text;
}

function normalizeCheckCursor(cursor) {
  return {
    ...defaultStore.checkCursor,
    ...(cursor || {})
  };
}

function normalizeSeriesDiscoveryCursor(cursor) {
  return {
    ...defaultStore.seriesDiscoveryCursor,
    ...(cursor || {})
  };
}

function normalizeImportQueue(queue) {
  const pending = Array.isArray(queue?.pending) ? queue.pending : [];
  const completed = Array.isArray(queue?.completed) ? queue.completed : [];
  const errors = Array.isArray(queue?.errors) ? queue.errors : [];
  return {
    pending: pending
      .filter((entry) => entry && entry.key && entry.input)
      .map((entry) => ({
        key: String(entry.key),
        input: String(entry.input),
        addedAt: entry.addedAt || ''
      })),
    completed: completed
      .filter((entry) => entry && entry.key && entry.input)
      .map((entry) => ({
        key: String(entry.key),
        input: String(entry.input),
        importedAt: entry.importedAt || '',
        mode: entry.mode || '',
        imported: Number(entry.imported || 0),
        skippedDuplicates: Number(entry.skippedDuplicates || 0),
        updatedDuplicates: Number(entry.updatedDuplicates || 0)
      })),
    errors: errors
      .filter((entry) => entry && entry.key && entry.input)
      .map((entry) => ({
        key: String(entry.key),
        input: String(entry.input),
        checkedAt: entry.checkedAt || '',
        error: String(entry.error || '')
      }))
  };
}

function normalizeAutomation(automation) {
  return {
    ...defaultStore.automation,
    ...(automation || {})
  };
}

function hasBlobConfig() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function readBlobStore() {
  const { store } = await readBlobStoreWithMetadata();
  return store;
}

async function updateBlobStore(mutator) {
  writeQueue = writeQueue.then(async () => {
    const { store } = await readBlobStoreWithMetadata({ force: true });
    const next = mergeStoreMutationResult(await mutator(store));
    await writeBlobStore(next);
    return next;
  });

  return writeQueue;
}

function mergeStoreMutationResult(result) {
  if (!isStoreLike(result)) {
    throw new Error('updateStore mutator must return the mutated store object');
  }
  return mergeStore(result);
}

function isStoreLike(value) {
  return (
    value &&
    typeof value === 'object' &&
    Array.isArray(value.books) &&
    Array.isArray(value.priceHistory) &&
    Array.isArray(value.notifications)
  );
}

async function readBlobStoreWithMetadata(options = {}) {
  const now = Date.now();
  if (!options.force && blobStoreCache.metadata && blobStoreCache.expiresAt > now) {
    return cloneBlobMetadata(blobStoreCache.metadata);
  }
  if (!options.force && blobStoreCache.promise) {
    return cloneBlobMetadata(await blobStoreCache.promise);
  }

  const promise = fetchBlobStoreWithMetadata();
  if (!options.force) blobStoreCache.promise = promise;
  try {
    const metadata = await promise;
    setBlobStoreCache(metadata);
    return cloneBlobMetadata(metadata);
  } finally {
    if (blobStoreCache.promise === promise) blobStoreCache.promise = null;
  }
}

async function fetchBlobStoreWithMetadata() {
  const { get } = await getBlobSdk();
  const result = await get(blobStorePath, { access: 'private', useCache: false });

  if (result?.statusCode !== 200 || !result.stream) {
    return { store: mergeStore(defaultStore), etag: '' };
  }

  const raw = await new Response(result.stream).text();
  return {
    store: mergeStore(JSON.parse(raw)),
    etag: result.blob?.etag || ''
  };
}

async function writeBlobStore(store) {
  const { put } = await getBlobSdk();
  await put(blobStorePath, JSON.stringify(compactStoreForWrite(store)), {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0
  });
  setBlobStoreCache({ store, etag: '' });
}

function compactStoreForWrite(store) {
  return compactObject({
    ...store,
    settings: compactAgainstDefaults(store.settings, defaultStore.settings),
    automation: compactAgainstDefaults(store.automation, defaultStore.automation),
    checkCursor: compactAgainstDefaults(store.checkCursor, defaultStore.checkCursor),
    seriesDiscoveryCursor: compactAgainstDefaults(store.seriesDiscoveryCursor, defaultStore.seriesDiscoveryCursor),
    books: (store.books || []).map(compactBookForWrite),
    priceHistory: (store.priceHistory || []).map(compactHistoryEntryForWrite),
    seriesPriceHistory: (store.seriesPriceHistory || []).map(compactSeriesHistoryEntryForWrite),
    notifications: (store.notifications || []).map(compactObject),
    importQueue: compactImportQueueForWrite(store.importQueue)
  });
}

function compactBookForWrite(book) {
  const imageKey = amazonImageKeyFromUrl(book.imageUrl) || emptyToUndefined(book.imageKey);
  return compactObject({
    ...book,
    amazonUrl: undefined,
    imageSource: undefined,
    imageKey,
    sourceUrl: emptyToUndefined(book.sourceUrl),
    importMode: book.importMode === 'single' ? undefined : book.importMode,
    currentPoints: Number(book.currentPoints || 0) === 0 ? undefined : book.currentPoints,
    previousEffectivePrice: book.previousEffectivePrice == null ? undefined : book.previousEffectivePrice,
    listPrice: book.listPrice == null ? undefined : book.listPrice,
    lowestPrice: book.lowestPrice == null ? undefined : book.lowestPrice,
    lowestEffectivePrice: book.lowestEffectivePrice == null ? undefined : book.lowestEffectivePrice,
    seriesKey: emptyToUndefined(book.seriesKey),
    seriesName: emptyToUndefined(book.seriesName),
    volume: emptyToUndefined(book.volume),
    seriesExpectedCount: emptyToUndefined(book.seriesExpectedCount),
    imageUrl: imageKey ? undefined : emptyToUndefined(book.imageUrl),
    seriesCompleted: book.seriesCompleted ? true : undefined,
    seriesCompletedAt: emptyToUndefined(book.seriesCompletedAt),
    seriesLastDiscoveredAt: emptyToUndefined(book.seriesLastDiscoveredAt),
    seriesDiscoveryStatus: emptyToUndefined(book.seriesDiscoveryStatus),
    seriesDiscoverySkipReason: emptyToUndefined(book.seriesDiscoverySkipReason),
    seriesDiscoverySkippedAt: emptyToUndefined(book.seriesDiscoverySkippedAt),
    seriesDiscoveryError: emptyToUndefined(book.seriesDiscoveryError),
    lastError: emptyToUndefined(book.lastError)
  });
}

function amazonImageKeyFromUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.hostname !== 'm.media-amazon.com') return '';
    const prefix = '/images/I/';
    if (!url.pathname.startsWith(prefix)) return '';
    return decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    if (text.startsWith(amazonImagePrefix)) return text.slice(amazonImagePrefix.length).split('?')[0];
  }
  return '';
}

function amazonImageUrlForKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (/^https?:\/\//i.test(key)) return key;
  return `${amazonImagePrefix}${encodeURI(key)}`;
}

function compactHistoryEntryForWrite(entry) {
  return compactObject({
    ...entry,
    points: Number(entry.points || 0) === 0 ? undefined : entry.points,
    listPrice: entry.listPrice == null ? undefined : entry.listPrice,
    provider: emptyToUndefined(entry.provider)
  });
}

function compactSeriesHistoryEntryForWrite(entry) {
  return compactObject({
    ...entry,
    sourceUrl: emptyToUndefined(entry.sourceUrl),
    currentPointsTotal: Number(entry.currentPointsTotal || 0) === 0 ? undefined : entry.currentPointsTotal,
    observedFrom: emptyToUndefined(entry.observedFrom),
    observedTo: emptyToUndefined(entry.observedTo)
  });
}

function compactImportQueueForWrite(queue = {}) {
  return compactObject({
    pending: (queue.pending || []).map((entry) =>
      compactObject({
        key: entry.key,
        input: entry.input,
        addedAt: emptyToUndefined(entry.addedAt)
      })
    ),
    completed: (queue.completed || []).map((entry) =>
      compactObject({
        key: entry.key,
        input: entry.input,
        importedAt: emptyToUndefined(entry.importedAt),
        mode: emptyToUndefined(entry.mode),
        imported: Number(entry.imported || 0) || undefined,
        skippedDuplicates: Number(entry.skippedDuplicates || 0) || undefined,
        updatedDuplicates: Number(entry.updatedDuplicates || 0) || undefined
      })
    ),
    errors: (queue.errors || []).map((entry) =>
      compactObject({
        key: entry.key,
        input: entry.input,
        checkedAt: emptyToUndefined(entry.checkedAt),
        error: emptyToUndefined(entry.error)
      })
    )
  });
}

function compactAgainstDefaults(value = {}, defaults = {}) {
  const compacted = {};
  for (const [key, currentValue] of Object.entries(value || {})) {
    if (JSON.stringify(currentValue) === JSON.stringify(defaults[key])) continue;
    compacted[key] = currentValue;
  }
  return compactObject(compacted);
}

function compactObject(object) {
  const compacted = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (isPlainObject(value)) {
      const nested = compactObject(value);
      if (Object.keys(nested).length > 0) compacted[key] = nested;
      continue;
    }
    compacted[key] = value;
  }
  return compacted;
}

function emptyToUndefined(value) {
  return value == null || value === '' ? undefined : value;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function getBlobSdk() {
  blobSdkPromise ||= import('@vercel/blob');
  return blobSdkPromise;
}

function setBlobStoreCache(metadata) {
  blobStoreCache = {
    expiresAt: Date.now() + blobStoreMemoryCacheMs(),
    metadata: cloneBlobMetadata(metadata),
    promise: null
  };
}

function cloneBlobMetadata(metadata) {
  return {
    store: cloneJson(metadata.store),
    etag: metadata.etag || ''
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function blobStoreMemoryCacheMs() {
  const value = Number(process.env.BLOB_STORE_MEMORY_CACHE_MS);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 15000;
}
