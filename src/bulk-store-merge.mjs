import { extractAsin } from './amazon-url.mjs';
import { isSingleBookRecord } from './series-identity.mjs';

export function cloneBulkStoreSnapshot(store) {
  return JSON.parse(JSON.stringify(store || {}));
}

export function mergeBulkCheckStoreForPersist(currentStore = {}, runStore = {}, baseStore = {}) {
  return {
    ...currentStore,
    books: mergeBulkBooks(currentStore.books || [], runStore.books || [], baseStore.books || []),
    priceHistory: mergeStoreEntries(
      currentStore.priceHistory || [],
      runStore.priceHistory || [],
      baseStore.priceHistory || [],
      'price'
    ),
    seriesPriceHistory: mergeStoreEntries(
      currentStore.seriesPriceHistory || [],
      runStore.seriesPriceHistory || [],
      baseStore.seriesPriceHistory || [],
      'series-price'
    ),
    notifications: mergeStoreEntries(
      currentStore.notifications || [],
      runStore.notifications || [],
      baseStore.notifications || [],
      'notification'
    ),
    checkCursor: latestStoreCursor(currentStore.checkCursor, runStore.checkCursor),
    seriesDiscoveryCursor: latestStoreCursor(currentStore.seriesDiscoveryCursor, runStore.seriesDiscoveryCursor),
    importQueue: mergeBulkImportQueue(currentStore.importQueue, runStore.importQueue, baseStore.importQueue)
  };
}

function mergeBulkBooks(currentBooks, runBooks, baseBooks) {
  const currentKeys = new Set(currentBooks.map(bookIdentityKey).filter(Boolean));
  const runByKey = mapByIdentity(runBooks, bookIdentityKey);
  const baseByKey = mapByIdentity(baseBooks, bookIdentityKey);
  const runSeriesSourceAsins = new Set(
    runBooks
      .filter((book) => !isSingleBookRecord(book))
      .map((book) => extractAsin(book.sourceUrl) || String(book.seriesKey || '').match(/^series:asin:([A-Z0-9]{10})$/i)?.[1])
      .filter(Boolean)
      .map((asin) => String(asin).toUpperCase())
  );
  const merged = [];

  for (const currentBook of currentBooks) {
    const key = bookIdentityKey(currentBook);
    if (!key) {
      merged.push(currentBook);
      continue;
    }

    const runBook = runByKey.get(key);
    const baseBook = baseByKey.get(key);
    if (runBook) {
      if (!baseBook) {
        merged.push(currentBook);
        continue;
      }

      const runChanged = !sameStoreValue(runBook, baseBook);
      const currentChanged = !sameStoreValue(currentBook, baseBook);
      if (runChanged && currentChanged) {
        merged.push(mergeStoreObjectChanges(baseBook, runBook, currentBook));
      } else if (runChanged) {
        merged.push(runBook);
      } else {
        merged.push(currentBook);
      }
      continue;
    }

    if (baseBook && shouldKeepSeriesContainerRemoval(currentBook, baseBook, runSeriesSourceAsins)) continue;
    if (baseBook && sameStoreValue(currentBook, baseBook)) continue;
    merged.push(currentBook);
  }

  for (const runBook of runBooks) {
    const key = bookIdentityKey(runBook);
    if (!key || currentKeys.has(key)) continue;
    const baseBook = baseByKey.get(key);
    if (!baseBook || !sameStoreValue(runBook, baseBook)) merged.push(runBook);
  }

  return merged;
}

function shouldKeepSeriesContainerRemoval(currentBook, baseBook, runSeriesSourceAsins) {
  const asin = String(baseBook?.asin || '').toUpperCase();
  if (!asin || !runSeriesSourceAsins.has(asin)) return false;
  return isSingleBookRecord(baseBook) && isSingleBookRecord(currentBook);
}

function mergeStoreObjectChanges(baseObject = {}, runObject = {}, currentObject = {}) {
  const merged = { ...currentObject };
  const keys = new Set([...Object.keys(baseObject || {}), ...Object.keys(runObject || {})]);
  for (const key of keys) {
    if (sameStoreValue(runObject?.[key], baseObject?.[key])) continue;
    if (runObject?.[key] === undefined) {
      delete merged[key];
    } else {
      merged[key] = cloneBulkStoreSnapshot(runObject[key]);
    }
  }
  return merged;
}

function mergeStoreEntries(currentEntries, runEntries, baseEntries, namespace) {
  const baseKeys = new Set(baseEntries.map((entry) => storeEntryKey(entry, namespace)));
  const runKeys = new Set(runEntries.map((entry) => storeEntryKey(entry, namespace)));
  const currentKeys = new Set();
  const merged = [];

  for (const entry of currentEntries) {
    const key = storeEntryKey(entry, namespace);
    if (baseKeys.has(key) && !runKeys.has(key)) continue;
    currentKeys.add(key);
    merged.push(entry);
  }

  for (const entry of runEntries) {
    const key = storeEntryKey(entry, namespace);
    if (currentKeys.has(key)) continue;
    if (!baseKeys.has(key)) {
      currentKeys.add(key);
      merged.push(entry);
    }
  }

  return merged;
}

function mergeBulkImportQueue(currentQueue = {}, runQueue = {}, baseQueue = {}) {
  return {
    pending: mergeStoreEntries(currentQueue.pending || [], runQueue.pending || [], baseQueue.pending || [], 'queue-pending'),
    completed: mergeStoreEntries(
      currentQueue.completed || [],
      runQueue.completed || [],
      baseQueue.completed || [],
      'queue-completed'
    ),
    errors: mergeStoreEntries(currentQueue.errors || [], runQueue.errors || [], baseQueue.errors || [], 'queue-error')
  };
}

function latestStoreCursor(currentCursor = {}, runCursor = {}) {
  const currentTime = Date.parse(currentCursor?.checkedAt || '') || 0;
  const runTime = Date.parse(runCursor?.checkedAt || '') || 0;
  return runTime >= currentTime ? runCursor || currentCursor : currentCursor || runCursor;
}

function mapByIdentity(entries = [], keyFn) {
  const map = new Map();
  for (const entry of entries) {
    const key = keyFn(entry);
    if (key) map.set(key, entry);
  }
  return map;
}

function bookIdentityKey(book = {}) {
  const asin = String(book.asin || '').trim().toUpperCase();
  if (asin) return `asin:${asin}`;
  const id = String(book.id || '').trim();
  return id ? `id:${id}` : '';
}

function storeEntryKey(entry = {}, namespace = 'entry') {
  if (entry?.id) return `${namespace}:id:${entry.id}`;
  if (namespace === 'queue-pending' && entry?.key) return `${namespace}:key:${entry.key}`;
  if (entry?.bookId || entry?.asin || entry?.checkedAt || entry?.createdAt) {
    return `${namespace}:${entry.bookId || ''}:${entry.asin || ''}:${entry.checkedAt || entry.createdAt || ''}`;
  }
  return `${namespace}:json:${JSON.stringify(entry)}`;
}

function sameStoreValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
