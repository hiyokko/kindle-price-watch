import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { amazonUrlForAsin } from './amazon-url.mjs';
import { getBlobSdk, hasBlobConfig } from './blob-client.mjs';
import { createSerialTaskQueue } from './serial-task-queue.mjs';
import {
  blobWriteConflictAttempts,
  isBlobWriteConflict,
  isPromiseLike,
  nextStoreRevision
} from './store-update-policy.mjs';
import {
  pruneBlobPayloads,
  readBlobPayload,
  writeBlobPayload
} from './blob-payload-store.mjs';

const dataDir = path.join(process.cwd(), 'data');
const storePath = path.join(dataDir, 'store.json');
const amazonImagePrefix = 'https://m.media-amazon.com/images/I/';

const defaultStore = {
  version: 1,
  storeRevision: 0,
  settings: {
    notificationThreshold: 10,
    batchSize: 50,
    listPriceChallengeBatchSize: 50,
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
    lastCronResultErrors: 0,
    lastCronErrorBreakdown: [],
    lastCronErrorSamples: [],
    lastCronError: '',
    lastImportQueueProcessed: 0,
    lastImportQueueImported: 0,
    lastImportQueueErrors: 0,
    lastSeriesDiscoveryChecked: 0,
    lastSeriesDiscoveryAdded: 0,
    lastSeriesDiscoveryAdditions: [],
    lastSeriesDiscoveryCompleted: 0,
    lastSeriesDiscoverySkipped: 0,
    lastSeriesDiscoveryDeferred: 0,
    lastSeriesDiscoveryErrors: 0,
    lastSingleSeriesAuditEligible: 0,
    lastSingleSeriesAuditChecked: 0,
    lastSingleSeriesAuditConverted: 0,
    lastSingleSeriesAuditAdded: 0,
    lastSingleSeriesAuditNoSeries: 0,
    lastSingleSeriesAuditErrors: 0,
    lastPriceIntegrityAuditChecked: 0,
    lastPriceIntegrityAuditSuspicious: 0,
    lastPriceIntegrityAuditWarnings: 0,
    lastPriceIntegrityAuditRepaired: 0,
    lastPriceIntegrityAuditUnresolved: 0,
    lastPriceIntegrityAuditFindings: [],
    lastListPriceChallengeEligible: 0,
    lastListPriceChallengeAttempted: 0,
    lastListPriceChallengeUpdated: 0,
    lastListPriceChallengeNotFound: 0,
    lastListPriceChallengeRejected: 0,
    lastListPriceChallengeErrors: 0,
    lastListPriceChallengeSkippedRecentNotFound: 0,
    lastListPriceChallengeNotFoundSamples: [],
    lastListPriceChallengeStoppedByRuntimeLimit: false
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

const enqueueStoreWrite = createSerialTaskQueue();
let blobStoreCache = {
  expiresAt: 0,
  metadata: null,
  promise: null
};
const storeWriteListeners = new Set();

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
    storeRevision: Math.max(0, Math.round(Number(store?.storeRevision) || 0)),
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
  const {
    checkRunsPerDay,
    checkIntervalHours,
    checkExecutionHourJst,
    checkExecutionMinuteJst,
    secondCheckExecutionHourJst,
    secondCheckExecutionMinuteJst,
    ...currentSettings
  } = settings || {};

  return {
    ...defaultStore.settings,
    ...currentSettings
  };
}

export async function readStore() {
  const { store } = await readStoreWithMetadata();
  return store;
}

export async function readStoreWithMetadata(options = {}) {
  if (hasBlobConfig()) {
    return readBlobStoreWithMetadata(options);
  }

  await ensureStore();
  const raw = await fs.readFile(storePath, 'utf8');
  return {
    store: mergeStore(JSON.parse(raw)),
    etag: responseEtag(raw),
    size: Buffer.byteLength(raw)
  };
}

export async function updateStore(mutator) {
  if (hasBlobConfig()) {
    return updateBlobStore(mutator);
  }

  return enqueueStoreWrite(async () => {
    const store = await readStore();
    const previousRevision = store.storeRevision;
    const next = nextStoreRevision(mergeStoreMutationResult(await mutator(store)), previousRevision);
    const tmpPath = `${storePath}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2));
    await fs.rename(tmpPath, storePath);
    await notifyStoreWritten(next, { etag: '', size: 0 });
    return next;
  });
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
    releaseDate: book.releaseDate || '',
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
  if (!book || isSeriesDerivedPriceProvider(book.listPriceProvider || book.provider)) return null;
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
  const importMode = book?.importMode || 'single';
  return {
    ...book,
    asin: asin || book?.asin,
    imageUrl,
    imageSource: book?.imageSource || '',
    amazonUrl: book?.amazonUrl || (asin ? amazonUrlForAsin(asin) : ''),
    sourceUrl: normalizeStoredSourceUrl(book, asin, importMode),
    currentPoints: Number(book?.currentPoints || 0),
    importMode
  };
}

function normalizeStoredSourceUrl(book = {}, asin = '', importMode = 'single') {
  const value = String(book?.sourceUrl || '').trim();
  if (!value) return '';
  const normalizedAsin = String(asin || '').toUpperCase();
  if (importMode !== 'kindle_series' && normalizedAsin && sourceUrlPointsToAsin(value, normalizedAsin)) {
    return amazonUrlForAsin(normalizedAsin);
  }
  return value;
}

function sourceUrlPointsToAsin(value, asin) {
  const normalizedAsin = String(asin || '').toUpperCase();
  if (!normalizedAsin) return false;
  if (String(value || '').trim().toUpperCase() === normalizedAsin) return true;
  try {
    const url = new URL(String(value || '').trim());
    if (!/amazon\./i.test(url.hostname)) return false;
    return new RegExp(`/(?:dp|gp/product|gp/aw/d)/${normalizedAsin}(?:[/?#]|$)`, 'i').test(url.pathname);
  } catch {
    return false;
  }
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
  const merged = {
    ...defaultStore.automation,
    ...(automation || {})
  };
  return {
    ...merged,
    lastSeriesDiscoveryAdditions: normalizeSeriesDiscoveryAdditions(merged.lastSeriesDiscoveryAdditions)
  };
}

function normalizeSeriesDiscoveryAdditions(additions) {
  if (!Array.isArray(additions)) return [];
  return additions
    .filter((entry) => entry && (entry.id || entry.asin))
    .slice(0, 50)
    .map((entry) => ({
      id: entry.id ? String(entry.id) : '',
      asin: entry.asin ? String(entry.asin) : '',
      title: entry.title ? String(entry.title) : '',
      seriesName: entry.seriesName ? String(entry.seriesName) : '',
      sourceUrl: entry.sourceUrl ? String(entry.sourceUrl) : '',
      createdAt: entry.createdAt || '',
      seriesLastDiscoveredAt: entry.seriesLastDiscoveredAt || ''
    }));
}

export { hasBlobConfig };

async function updateBlobStore(mutator) {
  return enqueueStoreWrite(async () => {
    const maxAttempts = blobWriteConflictAttempts();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const current = await readBlobStoreWithMetadata({ force: true });
      const previousRevision = current.store.storeRevision;
      const mutation = mutator(current.store);
      const retryable = !isPromiseLike(mutation);
      const next = nextStoreRevision(mergeStoreMutationResult(await mutation), previousRevision);

      try {
        const metadata = await writeBlobStore(next, current.blobEtags);
        await notifyStoreWritten(next, metadata);
        return next;
      } catch (error) {
        if (!isBlobWriteConflict(error) || !retryable || attempt >= maxAttempts) {
          if (isBlobWriteConflict(error)) error.status = 409;
          throw error;
        }
      }
    }

    throw new Error('Blob store update retry limit exceeded');
  });
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

export async function readStoreHeadMetadata(options = {}) {
  if (!hasBlobConfig()) {
    const { etag, size } = await readStoreWithMetadata();
    return { etag, size };
  }

  const now = Date.now();
  if (!options.force && blobStoreCache.metadata?.etag && blobStoreCache.expiresAt > now) {
    return {
      etag: blobStoreCache.metadata.etag || '',
      size: blobStoreCache.metadata.size || 0
    };
  }

  const result = await headBlobStore();
  return {
    etag: result?.etag || '',
    size: result?.size || 0
  };
}

export async function readBlobBootstrapPayload(storeEtag, options = {}) {
  return readBlobPayload('bootstrap', storeEtag, options);
}

export async function writeBlobBootstrapPayload(storeEtag, body) {
  return writeBlobPayload('bootstrap', storeEtag, body);
}

export async function readBlobControlPayload(storeEtag, options = {}) {
  return readBlobPayload('control', storeEtag, options);
}

export async function writeBlobControlPayload(storeEtag, body) {
  return writeBlobPayload('control', storeEtag, body);
}

export async function pruneBlobDerivedPayloads(options = {}) {
  const kinds = options.includeLegacyBooks
    ? ['bootstrap', 'control', 'books']
    : ['bootstrap', 'control'];
  return pruneBlobPayloads(kinds, options);
}

export function registerStoreWriteListener(listener) {
  storeWriteListeners.add(listener);
  return () => storeWriteListeners.delete(listener);
}

async function notifyStoreWritten(store, metadata = {}) {
  if (storeWriteListeners.size === 0) return;
  await Promise.all(
    [...storeWriteListeners].map(async (listener) => {
      try {
        await listener(store, metadata);
      } catch (error) {
        console.error('Store write listener failed', error);
      }
    })
  );
}

async function fetchBlobStoreWithMetadata() {
  const { get } = await getBlobSdk();
  const target = await resolveBlobStoreTarget();
  if (!target) {
    return { store: mergeStore(defaultStore), etag: '', size: 0, blobEtags: {} };
  }

  const primary = await readBlobStoreCandidate(get, target, target.blobEtags);
  if (!primary) {
    return { store: mergeStore(defaultStore), etag: '', size: 0, blobEtags: target.blobEtags };
  }

  const alternate = alternateBlobStoreTarget(target);
  if (!alternate || compressedStoreMatchesLegacy(primary, target)) return primary;

  const secondary = await readBlobStoreCandidate(get, alternate, target.blobEtags);
  return secondary ? selectNewestBlobStoreState(primary, secondary) : primary;
}

async function writeBlobStore(store, expectedEtags = {}) {
  const { put } = await getBlobSdk();
  const compacted = compactStoreForWrite(store);
  const legacyRaw = JSON.stringify(compacted);
  const legacyResult = await mirrorLegacyBlobStore(put, legacyRaw, expectedEtags.legacy);
  const stored = mergeStore({ ...store, blobMirrorEtag: legacyResult?.etag || '' });
  const compressed = gzipSync(JSON.stringify({
    ...compacted,
    blobMirrorEtag: legacyResult?.etag || ''
  }));
  const result = await put(compressedBlobStorePath(), compressed, {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/gzip',
    cacheControlMaxAge: 0,
    ...(expectedEtags.compressed ? { ifMatch: expectedEtags.compressed } : {})
  });

  const metadata = {
    store: stored,
    etag: result?.etag || '',
    size: compressed.length,
    blobEtags: {
      legacy: legacyResult?.etag || '',
      compressed: result?.etag || ''
    }
  };
  setBlobStoreCache(metadata);
  return metadata;
}

async function mirrorLegacyBlobStore(put, raw, expectedEtag = '') {
  return put(blobStorePath(), raw, {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
    ...(expectedEtag ? { ifMatch: expectedEtag } : {})
  });
}

async function headBlobStore() {
  return (await resolveBlobStoreTarget())?.metadata || null;
}

async function resolveBlobStoreTarget() {
  const { head } = await getBlobSdk();
  const [compressed, legacy] = await Promise.all([
    head(compressedBlobStorePath()).catch(() => null),
    head(blobStorePath()).catch(() => null)
  ]);
  const candidate = selectNewestBlobStore(compressed, legacy);
  if (!candidate) return null;
  const blobEtags = {
    compressed: compressed?.etag || '',
    legacy: legacy?.etag || ''
  };
  return candidate === compressed
    ? {
        pathname: compressedBlobStorePath(),
        compressed: true,
        metadata: compressed,
        alternateMetadata: legacy,
        blobEtags
      }
    : {
        pathname: blobStorePath(),
        compressed: false,
        metadata: legacy,
        alternateMetadata: compressed,
        blobEtags
      };
}

async function readBlobStoreCandidate(get, target, blobEtags) {
  const result = await get(target.pathname, { access: 'private', useCache: false });
  if (result?.statusCode !== 200 || !result.stream) return null;

  if (target.compressed) {
    const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
    const raw = gunzipSync(bytes).toString('utf8');
    return blobStoreMetadata(raw, result.blob, bytes.length, blobEtags, target);
  }

  const raw = await new Response(result.stream).text();
  return blobStoreMetadata(raw, result.blob, Buffer.byteLength(raw), blobEtags, target);
}

function alternateBlobStoreTarget(target) {
  if (!target?.alternateMetadata) return null;
  return target.compressed
    ? { pathname: blobStorePath(), compressed: false, metadata: target.alternateMetadata }
    : { pathname: compressedBlobStorePath(), compressed: true, metadata: target.alternateMetadata };
}

function compressedStoreMatchesLegacy(primary, target) {
  if (!target.compressed) return false;
  const expectedLegacyEtag = String(primary.store?.blobMirrorEtag || '');
  const currentLegacyEtag = String(target.blobEtags?.legacy || '');
  return Boolean(expectedLegacyEtag && expectedLegacyEtag === currentLegacyEtag);
}

export function selectNewestBlobStoreState(left, right) {
  const leftRevision = Number(left?.store?.storeRevision || 0);
  const rightRevision = Number(right?.store?.storeRevision || 0);
  if (leftRevision !== rightRevision) return leftRevision > rightRevision ? left : right;

  const compressed = left?.compressed ? left : right?.compressed ? right : null;
  const legacy = left?.compressed === false ? left : right?.compressed === false ? right : null;
  if (!compressed) return legacy || left;
  if (!legacy) return compressed;
  const selected = selectNewestBlobStore(compressed.sourceMetadata, legacy.sourceMetadata);
  return selected === compressed.sourceMetadata ? compressed : legacy;
}

export function selectNewestBlobStore(compressed, legacy) {
  if (!compressed) return legacy || null;
  if (!legacy) return compressed;

  const compressedAt = Date.parse(compressed.uploadedAt || '');
  const legacyAt = Date.parse(legacy.uploadedAt || '');
  if (Number.isFinite(legacyAt) && (!Number.isFinite(compressedAt) || legacyAt > compressedAt)) {
    return legacy;
  }
  return compressed;
}

function blobStoreMetadata(raw, blob = {}, fallbackSize = 0, blobEtags = {}, source = {}) {
  return {
    store: mergeStore(JSON.parse(raw)),
    etag: blob?.etag || '',
    size: blob?.size || fallbackSize,
    blobEtags,
    compressed: Boolean(source.compressed),
    sourceMetadata: source.metadata || blob || null
  };
}

function compactStoreForWrite(store) {
  return compactObject({
    ...store,
    blobMirrorEtag: undefined,
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
    singleSeriesAuditStatus: emptyToUndefined(book.singleSeriesAuditStatus),
    singleSeriesAuditedAt: emptyToUndefined(book.singleSeriesAuditedAt),
    singleSeriesAuditError: emptyToUndefined(book.singleSeriesAuditError),
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

function responseEtag(value) {
  return `"${createHash('sha256').update(String(value)).digest('base64url')}"`;
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

function blobStorePath() {
  return process.env.BLOB_STORE_PATH || 'kindle-price-watch/store.json';
}

function compressedBlobStorePath() {
  return `${blobStorePath()}.gz`;
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
    etag: metadata.etag || '',
    size: metadata.size || 0,
    blobEtags: { ...(metadata.blobEtags || {}) }
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function blobStoreMemoryCacheMs() {
  const value = Number(process.env.BLOB_STORE_MEMORY_CACHE_MS);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 15000;
}
