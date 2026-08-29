import crypto from 'node:crypto';
import { normalizeSeriesIdentityName, seriesCandidatesAreCompatible } from './series-identity.mjs';

export function auditStoreAgainstReference(store = {}, referenceStore = {}) {
  const productionBooks = Array.isArray(store.books) ? store.books : [];
  const referenceBooks = Array.isArray(referenceStore.books) ? referenceStore.books : [];
  const productionByAsin = new Map(productionBooks.map((book) => [normalizedAsin(book.asin), book]));
  const referenceGroups = seriesGroups(referenceBooks);
  const productionGroups = seriesGroups(productionBooks);
  const seriesIdentityFindings = [];

  for (const [seriesKey, referenceGroup] of referenceGroups.entries()) {
    const productionGroup = productionGroups.get(seriesKey);
    if (!productionGroup) continue;

    const sharedAsins = referenceGroup.books.filter((book) =>
      productionGroup.asins.has(normalizedAsin(book.asin))
    );
    const compatible = seriesCandidatesAreCompatible(
      { seriesName: referenceGroup.seriesName, items: referenceGroup.books },
      { seriesName: productionGroup.seriesName, items: productionGroup.books }
    );
    if (compatible) continue;

    seriesIdentityFindings.push({
      type: 'series_identity_mismatch',
      seriesKey,
      referenceSeriesName: referenceGroup.seriesName,
      productionSeriesName: productionGroup.seriesName,
      referenceCount: referenceGroup.books.length,
      productionCount: productionGroup.books.length,
      sharedCount: sharedAsins.length,
      referenceAsins: [...referenceGroup.asins],
      productionAsins: [...productionGroup.asins]
    });
  }

  const titleChanges = [];
  for (const referenceBook of referenceBooks) {
    const productionBook = productionByAsin.get(normalizedAsin(referenceBook.asin));
    if (!productionBook || !isMaterialTitleChange(referenceBook.title, productionBook.title)) continue;
    titleChanges.push({
      type: 'book_title_mismatch',
      asin: normalizedAsin(referenceBook.asin),
      referenceTitle: referenceBook.title || '',
      productionTitle: productionBook.title || '',
      referenceSeriesName: referenceBook.seriesName || '',
      productionSeriesName: productionBook.seriesName || ''
    });
  }

  const missingReferenceBooks = referenceBooks
    .filter((book) => !productionByAsin.has(normalizedAsin(book.asin)))
    .map((book) => ({
      asin: normalizedAsin(book.asin),
      title: book.title || '',
      seriesKey: seriesGroupKey(book),
      seriesName: book.seriesName || ''
    }));

  return {
    referenceBookCount: referenceBooks.length,
    productionBookCount: productionBooks.length,
    overlappingBookCount: referenceBooks.length - missingReferenceBooks.length,
    seriesIdentityFindings,
    titleChanges,
    missingReferenceBooks
  };
}

export function restoreSeriesGroupsFromReference(store, referenceStore, seriesKeys = [], options = {}) {
  const now = options.now || new Date().toISOString();
  const selectedKeys = [...new Set(seriesKeys.map((key) => String(key || '').trim()).filter(Boolean))];
  const referenceGroups = seriesGroups(referenceStore.books || []);
  const findings = new Map(
    auditStoreAgainstReference(store, referenceStore).seriesIdentityFindings.map((finding) => [finding.seriesKey, finding])
  );
  const summaries = [];

  for (const seriesKey of selectedKeys) {
    const referenceGroup = referenceGroups.get(seriesKey);
    if (!referenceGroup) throw new Error(`Reference series was not found: ${seriesKey}`);
    if (!findings.has(seriesKey) && options.allowNonMismatch !== true) {
      throw new Error(`Series identity mismatch was not found: ${seriesKey}`);
    }

    const currentBooks = (store.books || []).filter((book) => seriesGroupKey(book) === seriesKey);
    const removedBookIds = new Set(currentBooks.map((book) => book.id).filter(Boolean));
    const removedAsins = new Set(currentBooks.map((book) => normalizedAsin(book.asin)).filter(Boolean));
    const referenceBookIds = new Set(referenceGroup.books.map((book) => book.id).filter(Boolean));
    const remainingBookIds = new Set(
      (store.books || [])
        .filter((book) => !removedBookIds.has(book.id))
        .map((book) => book.id)
        .filter(Boolean)
    );
    const replacementIdByReferenceId = new Map();
    const restoredBooks = referenceGroup.books.map((book) => {
      const originalId = book.id || crypto.randomUUID();
      const id = remainingBookIds.has(originalId) ? crypto.randomUUID() : originalId;
      remainingBookIds.add(id);
      replacementIdByReferenceId.set(originalId, id);
      return {
        ...clone(book),
        id,
        seriesKey,
        seriesName: referenceGroup.seriesName,
        seriesLastDiscoveredAt: now,
        seriesDiscoveryStatus: 'checked',
        seriesDiscoverySkipReason: '',
        seriesDiscoverySkippedAt: '',
        seriesDiscoveryError: '',
        updatedAt: now
      };
    });

    store.books = (store.books || []).filter((book) => !removedBookIds.has(book.id));
    store.books.push(...restoredBooks);
    store.priceHistory = (store.priceHistory || []).filter((entry) => !removedBookIds.has(entry.bookId));
    const restoredHistory = (referenceStore.priceHistory || [])
      .filter((entry) => referenceBookIds.has(entry.bookId))
      .map((entry) => ({
        ...clone(entry),
        bookId: replacementIdByReferenceId.get(entry.bookId) || entry.bookId
      }));
    store.priceHistory.push(...restoredHistory);
    store.seriesPriceHistory = (store.seriesPriceHistory || []).filter(
      (entry) => !seriesArtifactMatches(entry, seriesKey, removedBookIds, removedAsins)
    );
    store.notifications = (store.notifications || []).filter(
      (entry) => !seriesArtifactMatches(entry, seriesKey, removedBookIds, removedAsins)
    );

    if (removedBookIds.has(store.checkCursor?.lastBookId)) {
      store.checkCursor = { lastBookId: '', lastAsin: '', lastTitle: '', checkedAt: '' };
    }
    if (store.seriesDiscoveryCursor?.lastSeriesKey === seriesKey) {
      store.seriesDiscoveryCursor = { lastSeriesKey: seriesKey, checkedAt: now };
    }

    summaries.push({
      seriesKey,
      seriesName: referenceGroup.seriesName,
      removed: currentBooks.length,
      restored: restoredBooks.length,
      restoredAsins: restoredBooks.map((book) => normalizedAsin(book.asin))
    });
  }

  return { repairedSeries: summaries.length, summaries };
}

function seriesGroups(books = []) {
  const groups = new Map();
  for (const book of books) {
    const key = seriesGroupKey(book);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { books: [], asins: new Set(), names: new Map() });
    const group = groups.get(key);
    group.books.push(book);
    const asin = normalizedAsin(book.asin);
    if (asin) group.asins.add(asin);
    const name = String(book.seriesName || '').trim();
    if (name) group.names.set(name, (group.names.get(name) || 0) + 1);
  }

  for (const group of groups.values()) {
    group.seriesName = [...group.names.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || '';
  }
  return groups;
}

function seriesGroupKey(book = {}) {
  return String(book.seriesKey || book.sourceUrl || '').trim();
}

function seriesArtifactMatches(entry = {}, seriesKey, bookIds, asins) {
  if (entry.seriesKey === seriesKey || entry.key === seriesKey || entry.scopeKey === seriesKey) return true;
  if (entry.bookId && bookIds.has(entry.bookId)) return true;
  return Boolean(entry.asin && asins.has(normalizedAsin(entry.asin)));
}

function isMaterialTitleChange(referenceTitle = '', productionTitle = '') {
  const reference = normalizedTitleStem(referenceTitle);
  const production = normalizedTitleStem(productionTitle);
  if (!reference || !production || reference === production) return false;
  return !reference.includes(production) && !production.includes(reference);
}

function normalizedTitleStem(value = '') {
  return normalizeSeriesIdentityName(
    String(value || '')
      .replace(/[（(][^（）()]{0,40}巻相当[^（）()]{0,40}[）)]/gu, ' ')
      .replace(/巻之[壱弐参肆伍陸漆捌玖拾一二三四五六七八九十]+/gu, ' ')
      .replace(/(?:第\s*)?[0-9０-９]{1,4}\s*巻/giu, ' ')
      .replace(/[（(]\s*[0-9０-９]{1,4}\s*[）)]/gu, ' ')
      .replace(/\s+[0-9０-９]{1,4}(?=\s|$)/gu, ' ')
  );
}

function normalizedAsin(value = '') {
  return String(value || '').trim().toUpperCase();
}

function clone(value) {
  return structuredClone(value);
}
