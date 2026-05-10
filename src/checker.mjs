import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  amazonUrlForAsin,
  extractAsin,
  fetchAmazonHtmlSnapshot,
  fetchBookSnapshot,
  fetchEfoxKindleSeriesItems,
  fetchExternalKindleSeriesItems,
  fetchKinpomeKindleSeriesItems,
  fetchKintyakuKindleSeriesItems,
  fetchKindleSeriesItems,
  fetchSaleBonKindleSeriesItems,
  isProbablyBookAsin,
  isKindleSeriesUrl
} from './price-provider.mjs';
import { readStore, updateStore, publicBook } from './store.mjs';
import { readWebhookStore, writeWebhookStore } from './webhook-store.mjs';
import {
  buildCronSummaryNotification,
  buildPriceNotification,
  getDiscordWebhookUrls,
  parseDiscordWebhookUrls,
  sendDiscordNotification
} from './notifier.mjs';

const UNVALIDATED_SERIES_PRICE_PROVIDERS = new Set([
  'amazon_series_source_price',
  'amazon_series_unit_price',
  'efox_series',
  'external_series',
  'kinpome_series',
  'kintyaku_series',
  'sale_bon_series'
]);
const SINGLE_EPISODE_SERIES_PRICE_MAX = 250;
const SUSPICIOUS_BULK_SERIES_COUNT_MIN = 20;

export async function listBooks() {
  const store = await readStoreWithPriceRepairs();
  const seriesHistory = seriesHistorySummaries(store);
  return store.books.map((book) => publicBookWithSeriesHistory(book, seriesHistory)).sort(sortBooks);
}

async function readStoreWithPriceRepairs(options = {}) {
  const now = options.now || new Date().toISOString();
  const store = await readStore();
  const repair = repairStorePriceState(store, { ...options, now });
  if (!repair.changed) return store;

  return updateStore((currentStore) => {
    repairStorePriceState(currentStore, { ...options, now });
    return currentStore;
  });
}

export async function addBook(input) {
  const asin = extractAsin(input);
  if (!asin) {
    const error = new Error('Amazon URL または ASIN を入力してください');
    error.status = 400;
    throw error;
  }
  if (!isProbablyBookAsin(asin)) {
    const error = new Error('Kindle本のASIN（Bで始まる10桁）またはKindle商品URLを入力してください');
    error.status = 400;
    throw error;
  }

  const existing = await findBookByAsin(asin);
  if (existing) {
    const error = new Error('この本は既に登録されています');
    error.status = 409;
    error.book = publicBook(existing);
    throw error;
  }

  const book = await buildBookFromAsin(asin, {
    fetchDetails: true,
    inputUrl: input,
    sourceUrl: String(input || '').trim()
  });
  if (isPermanentSnapshotError(book.lastError)) {
    const error = new Error(book.lastError);
    error.status = 400;
    throw error;
  }
  const now = book.createdAt;

  await updateStore((store) => {
    store.books.push(book);
    appendPriceHistoryEntry(store, book, now);
    return store;
  });

  return publicBook(book);
}

export async function addBooksFromInput(input) {
  const explicitSeriesUrl = isKindleSeriesUrl(input);
  let asins = [];
  let series;

  if (explicitSeriesUrl) {
    series = await fetchSeriesCandidates(input, { allowIncomplete: true });
    if (!series) {
      const error = new Error('シリーズ内のKindle ASINを取得できませんでした');
      error.status = 422;
      throw error;
    }
    asins = series.items.map((item) => item.asin);
  } else {
    series = await detectCollectionSeries(input);
    asins = series?.items?.map((item) => item.asin) || [];
  }

  if (explicitSeriesUrl && (!series || asins.length === 0)) {
    const error = new Error('シリーズ内のKindle ASINを取得できませんでした');
    error.status = 422;
    throw error;
  }

  if (!series || asins.length === 0) {
    const asin = extractAsin(input);
    const existing = asin ? await findBookByAsin(asin) : null;
    if (existing) {
      const refreshed = await refreshExistingSingleBookFromInput(existing.id, input);
      return {
        mode: 'single',
        imported: 0,
        skippedDuplicates: 1,
        updatedDuplicates: refreshed.updated ? 1 : 0,
        books: [refreshed.book],
        book: refreshed.book,
        errors: refreshed.book.lastError ? [refreshed.book.lastError] : []
      };
    }

    const book = await addBook(input);
    return {
      mode: 'single',
      imported: 1,
      skippedDuplicates: 0,
      books: [book],
      book,
      errors: []
    };
  }

  const fetchDetails = String(process.env.SERIES_IMPORT_FETCH_DETAILS || '').toLowerCase() === 'true';
  const now = new Date().toISOString();
  let result;
  await updateStore(async (store) => {
    result = await importSeriesIntoStore(store, input, series, { fetchDetails, now });
    return store;
  });

  return result;
}

export async function addBooksFromInputs(inputs, options = {}) {
  const queue = Array.isArray(inputs)
    ? inputs.map((input) => String(input || '').trim()).filter(Boolean)
    : parseBookImportInputs(inputs);
  const deduped = [...new Map(queue.map((input) => [bookImportQueueKey(input), input])).values()];
  const summary = {
    mode: 'batch',
    total: deduped.length,
    processed: 0,
    imported: 0,
    skippedDuplicates: 0,
    updatedDuplicates: 0,
    results: [],
    errors: []
  };
  if (deduped.length === 0) return summary;

  const now = options.now || new Date().toISOString();
  await updateStore(async (store) => {
    for (const input of deduped) {
      try {
        const result = await addBooksFromInputInStore(store, input, { ...options, now });
        const entry = {
          input,
          mode: result.mode || '',
          imported: Number(result.imported || 0),
          skippedDuplicates: Number(result.skippedDuplicates || 0),
          updatedDuplicates: Number(result.updatedDuplicates || 0),
          seriesCompleted: Boolean(result.seriesCompleted),
          errors: result.errors || []
        };
        summary.processed += 1;
        summary.imported += entry.imported;
        summary.skippedDuplicates += entry.skippedDuplicates;
        summary.updatedDuplicates += entry.updatedDuplicates;
        summary.results.push(entry);
      } catch (error) {
        summary.processed += 1;
        summary.errors.push({
          input,
          error: error.message || String(error)
        });
      }
    }
    return store;
  });

  return summary;
}

export async function addSeriesImports(imports, options = {}) {
  const queue = Array.isArray(imports) ? imports : [];
  const summary = {
    mode: 'series_import_batch',
    total: queue.length,
    processed: 0,
    imported: 0,
    skippedDuplicates: 0,
    updatedDuplicates: 0,
    results: [],
    errors: []
  };
  if (queue.length === 0) return summary;

  const now = options.now || new Date().toISOString();
  await updateStore(async (store) => {
    for (const entry of queue) {
      const input = String(entry?.input || '').trim();
      const series = entry?.series;
      try {
        if (!input || !series || !Array.isArray(series.items) || series.items.length === 0) {
          const error = new Error('シリーズ取り込みデータが不正です');
          error.status = 400;
          throw error;
        }
        const result = await importSeriesIntoStore(store, input, series, {
          fetchDetails: options.fetchDetails === true,
          now,
          recordInitialHistory: options.recordInitialHistory !== false
        });
        const resultEntry = {
          input,
          mode: result.mode || '',
          imported: Number(result.imported || 0),
          skippedDuplicates: Number(result.skippedDuplicates || 0),
          updatedDuplicates: Number(result.updatedDuplicates || 0),
          seriesCompleted: Boolean(result.seriesCompleted),
          errors: result.errors || []
        };
        summary.processed += 1;
        summary.imported += resultEntry.imported;
        summary.skippedDuplicates += resultEntry.skippedDuplicates;
        summary.updatedDuplicates += resultEntry.updatedDuplicates;
        summary.results.push(resultEntry);
      } catch (error) {
        summary.processed += 1;
        summary.errors.push({
          input,
          error: error.message || String(error)
        });
      }
    }
    return store;
  });

  return summary;
}

async function addBooksFromInputInStore(store, input, options = {}) {
  const explicitSeriesUrl = isKindleSeriesUrl(input);
  let asins = [];
  let series;

  if (explicitSeriesUrl) {
    series = await fetchSeriesCandidates(input, {
      allowIncomplete: true,
      skipExternalFallback: options.skipExternalFallback === true,
      skipBackfill: options.skipBackfill === true,
      signal: options.signal,
      timeoutMs: options.timeoutMs
    });
    if (!series) {
      const error = new Error('シリーズ内のKindle ASINを取得できませんでした');
      error.status = 422;
      throw error;
    }
    asins = series.items.map((item) => item.asin);
  } else {
    series = await detectCollectionSeries(input, options);
    asins = series?.items?.map((item) => item.asin) || [];
  }

  if (explicitSeriesUrl && (!series || asins.length === 0)) {
    const error = new Error('シリーズ内のKindle ASINを取得できませんでした');
    error.status = 422;
    throw error;
  }

  if (!series || asins.length === 0) {
    return addSingleBookFromInputInStore(store, input, options);
  }

  return importSeriesIntoStore(store, input, series, {
    fetchDetails: String(process.env.SERIES_IMPORT_FETCH_DETAILS || '').toLowerCase() === 'true',
    now: options.now || new Date().toISOString(),
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
}

async function addSeriesBooksFromInputInStore(store, input, options = {}) {
  const explicitSeriesUrl = isKindleSeriesUrl(input);
  const series = explicitSeriesUrl
    ? await fetchSeriesCandidates(input, { allowIncomplete: true, signal: options.signal, timeoutMs: options.timeoutMs })
    : await detectCollectionSeries(input, options);
  const asins = series?.items?.map((item) => item.asin) || [];

  if (!series || asins.length === 0) {
    const error = new Error('シリーズ内のKindle ASINを取得できませんでした');
    error.status = 422;
    throw error;
  }

  return importSeriesIntoStore(store, input, series, {
    fetchDetails: String(process.env.SERIES_IMPORT_FETCH_DETAILS || '').toLowerCase() === 'true',
    now: options.now || new Date().toISOString(),
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
}

async function addSingleBookFromInputInStore(store, input, options = {}) {
  const asin = extractAsin(input);
  if (!asin) {
    const error = new Error('Amazon URL または ASIN を入力してください');
    error.status = 400;
    throw error;
  }
  if (!isProbablyBookAsin(asin)) {
    const error = new Error('Kindle本のASIN（Bで始まる10桁）またはKindle商品URLを入力してください');
    error.status = 400;
    throw error;
  }

  const now = options.now || new Date().toISOString();
  const sourceUrl = String(input || '').trim();
  const existing = store.books.find((book) => book.asin === asin);
  if (existing) {
    let updated = false;
    if (sourceUrl && existing.sourceUrl !== sourceUrl) {
      existing.sourceUrl = sourceUrl;
      existing.updatedAt = now;
      updated = true;
    }
    return {
      mode: 'single',
      imported: 0,
      skippedDuplicates: 1,
      updatedDuplicates: updated ? 1 : 0,
      books: [publicBook(existing)],
      book: publicBook(existing),
      errors: existing.lastError ? [existing.lastError] : []
    };
  }

  const book = await buildBookFromAsin(asin, {
    fetchDetails: options.fetchDetails !== false,
    inputUrl: input,
    sourceUrl,
    createdAt: now,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
  if (isPermanentSnapshotError(book.lastError)) {
    const error = new Error(book.lastError);
    error.status = 400;
    throw error;
  }

  store.books.push(book);
  appendPriceHistoryEntry(store, book, now);

  return {
    mode: 'single',
    imported: 1,
    skippedDuplicates: 0,
    updatedDuplicates: 0,
    books: [publicBook(book)],
    book: publicBook(book),
    errors: book.lastError ? [book.lastError] : []
  };
}

async function importSeriesIntoStore(store, input, series, options = {}) {
  const fetchDetails = Boolean(options.fetchDetails);
  const now = options.now || new Date().toISOString();
  let importedBooks = [];
  let skippedDuplicates = 0;
  let updatedDuplicates = 0;
  const seriesErrors = [...(series.reconciliation?.errors || [])];
  const seriesKey = seriesKeyForSeries(input, series);
  const seriesName = series.seriesName || 'Kindle シリーズ';
  const sourceUrl = seriesSourceUrlFor(input, series);
  const seriesCompleted = Boolean(series.completed);

  const sourceIsSeriesItem = Boolean(series.sourceAsin && series.items.some((item) => item.asin === series.sourceAsin));
  const obsoleteIds = new Set(
    store.books
      .filter(
        (book) =>
          series.sourceAsin &&
          book.asin === series.sourceAsin &&
          !sourceIsSeriesItem &&
          (isSameSeriesSource(book.sourceUrl, sourceUrl, series.sourceAsin) || !book.seriesKey)
      )
      .map((book) => book.id)
  );
  if (obsoleteIds.size > 0) {
    removeStoreBooksById(store, obsoleteIds);
  }

  const seriesIdentity = {
    input,
    sourceUrl,
    sourceAsin: series.sourceAsin,
    seriesKey,
    seriesName
  };
  const mergedSeriesItems = mergeWithKnownSeriesItems(series.items, store.books, seriesIdentity);
  const seriesItems = [];
  for (const item of mergedSeriesItems) {
    if (isClearlyDifferentSeriesTitle(item.title, seriesName)) {
      seriesErrors.push(`${item.asin}: skipped title outside series (${item.title})`);
      continue;
    }
    seriesItems.push(item);
  }

  if (isSingleBookSeriesCandidate(series, seriesItems)) {
    return importSingleBookSeriesCandidateIntoStore(store, input, seriesItems[0], {
      ...options,
      now,
      sourceUrl
    });
  }

  const currentSeriesAsins = new Set(seriesItems.map((item) => item.asin).filter(Boolean));
  const obsoleteEpisodeIds = new Set(
    store.books
      .filter((book) => isKnownBookForSeries(book, seriesIdentity))
      .filter((book) => isLikelyObsoleteSingleEpisodeSeriesBook(book, currentSeriesAsins, seriesName))
      .map((book) => book.id)
  );
  if (obsoleteEpisodeIds.size > 0) {
    removeStoreBooksById(store, obsoleteEpisodeIds);
  }

  const existingByAsin = new Map(store.books.map((book) => [book.asin, book]));
  const seriesExpectedCount = normalizeSeriesExpectedCount(series, seriesItems);
  const existingSeriesBooks = store.books.filter((book) => isKnownBookForSeries(book, seriesIdentity));
  const weakImageUrls = weakSeriesImageUrls([...seriesItems, ...existingSeriesBooks]);
  const additions = [];

  for (const [index, item] of seriesItems.entries()) {
    const asin = item.asin;
    const existingBook = existingByAsin.get(asin);
    if (existingBook) {
      skippedDuplicates += 1;
      if (
        updateExistingSeriesBook(existingBook, item, {
          now,
          sourceUrl,
          seriesKey,
          seriesName,
          seriesExpectedCount,
          volume: seriesItemVolume(item) || index + 1,
          weakImageUrls,
          store
        })
      ) {
        updatedDuplicates += 1;
      }
      continue;
    }

    const book = await buildBookFromAsin(asin, {
      fetchDetails,
      seed: item,
      sourceUrl,
      importMode: 'kindle_series',
      createdAt: now,
      seriesKey,
      seriesName,
      seriesExpectedCount,
      volume: seriesItemVolume(item) || index + 1,
      signal: options.signal,
      timeoutMs: options.timeoutMs
    });
    if (isClearlyDifferentSeriesTitle(book.title, seriesName)) {
      seriesErrors.push(`${asin}: skipped title outside series (${book.title})`);
      continue;
    }
    additions.push(book);
    importedBooks.push(publicBook(book));
    existingByAsin.set(asin, book);
  }

  store.books.push(...additions);
  if (options.recordInitialHistory !== false) {
    for (const book of additions) {
      appendPriceHistoryEntry(store, book, now);
    }
  }

  for (const book of store.books.filter((item) => isKnownBookForSeries(item, seriesIdentity))) {
    applySeriesDiscoveryMetadata(book, {
      now,
      completed: seriesCompleted,
      error: ''
    });
  }

  return {
    mode: 'kindle_series',
    imported: importedBooks.length,
    skippedDuplicates,
    updatedDuplicates,
    seriesCompleted,
    books: importedBooks,
    errors: seriesErrors
  };
}

async function importSingleBookSeriesCandidateIntoStore(store, input, item, options = {}) {
  const now = options.now || new Date().toISOString();
  const asin = item?.asin || extractAsin(input);
  if (!asin) {
    const error = new Error('Amazon URL または ASIN を入力してください');
    error.status = 400;
    throw error;
  }

  const sourceUrl = String(options.sourceUrl || input || item?.amazonUrl || '').trim();
  const existing = store.books.find((book) => book.asin === asin);
  if (existing) {
    const before = singleBookSeriesState(existing);
    demoteBookToSingle(existing, { now, sourceUrl });
    applySingleSeriesCandidateSeed(existing, item, now);
    const changed = JSON.stringify(before) !== JSON.stringify(singleBookSeriesState(existing));
    if (changed) {
      removeSeriesArtifactsForScopes(store, singleBookSeriesScopes(before));
    }
    return {
      mode: 'single',
      imported: 0,
      skippedDuplicates: 1,
      updatedDuplicates: changed ? 1 : 0,
      books: [publicBook(existing)],
      book: publicBook(existing),
      errors: existing.lastError ? [existing.lastError] : []
    };
  }

  const book = await buildBookFromAsin(asin, {
    fetchDetails: options.fetchDetails !== false,
    seed: item,
    inputUrl: sourceUrl,
    sourceUrl,
    createdAt: now,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
  store.books.push(book);
  appendPriceHistoryEntry(store, book, now);

  return {
    mode: 'single',
    imported: 1,
    skippedDuplicates: 0,
    updatedDuplicates: 0,
    books: [publicBook(book)],
    book: publicBook(book),
    errors: book.lastError ? [book.lastError] : []
  };
}

function isSingleBookSeriesCandidate(series, items = []) {
  if (!Array.isArray(items) || items.length !== 1) return false;
  return normalizeSeriesExpectedCount(series, items) <= 1;
}

function applySingleSeriesCandidateSeed(book, item, now) {
  if (!book || !item) return false;
  let changed = false;
  if (item.title && preferSnapshotText(item.title, book.title) !== book.title) {
    book.title = preferSnapshotText(item.title, book.title);
    changed = true;
  }
  if (!book.imageUrl && item.imageUrl) {
    book.imageUrl = item.imageUrl;
    book.imageSource = item.imageSource || item.provider || '';
    changed = true;
  }
  if (!book.amazonUrl && item.amazonUrl) {
    book.amazonUrl = item.amazonUrl;
    changed = true;
  }
  if (changed) book.updatedAt = now;
  return changed;
}

async function refreshExistingSingleBookFromInput(id, input) {
  const now = new Date().toISOString();
  const sourceUrl = String(input || '').trim();
  let snapshotResult = null;
  if (sourceUrl) {
    snapshotResult = await settleSnapshotWithUrl(extractAsin(sourceUrl), sourceUrl, await findBookById(id));
  }

  let updated = false;
  let publicResult = null;

  await updateStore((store) => {
    const book = store.books.find((item) => item.id === id);
    if (!book) return store;

    if (sourceUrl && book.sourceUrl !== sourceUrl) {
      book.sourceUrl = sourceUrl;
      updated = true;
    }

    if (!snapshotResult?.ok) {
      if (snapshotResult?.snapshot) {
        applyMetadataSnapshotToBook(book, snapshotResult.snapshot);
        updated = true;
      }
      if (isAmazonErrorPageBookTitle(book.title)) {
        book.title = `ASIN ${book.asin}`;
        book.imageUrl = '';
        book.imageSource = '';
        book.provider = 'pending';
        updated = true;
      }
      if (snapshotResult?.error && book.lastError !== snapshotResult.error) {
        book.lastError = snapshotResult.error;
        updated = true;
      }
      if (isPermanentSnapshotError(snapshotResult?.error)) {
        book.lastCheckedAt = now;
        updated = true;
      } else if (isUnresolvedSingleBook(book) && book.lastCheckedAt) {
        book.lastCheckedAt = null;
        updated = true;
      }
      const repair = repairSuspiciousPriceState(book, store, {
        clearCurrent: true,
        restoreMissingCurrent: true
      });
      if (repair.changed) updated = true;
      if (isPermanentSnapshotError(snapshotResult?.error)) {
        book.lastCheckedAt = now;
      } else if ((repair.currentCleared && !repair.currentRestored) || isSuspiciousSnapshotError(snapshotResult?.error)) {
        book.lastCheckedAt = null;
      }
      if (updated) book.updatedAt = now;
      publicResult = publicBook(book);
      return store;
    }

    const previousEffectivePrice = book.effectivePrice;
    const snapshot = snapshotResult.snapshot;
    book.title = preferSnapshotText(snapshot.title, book.title);
    book.author = snapshot.author || book.author;
    book.publisher = snapshot.publisher || book.publisher;
    book.imageUrl = snapshot.imageUrl || book.imageUrl;
    book.imageSource = snapshot.imageUrl ? snapshot.provider || book.imageSource || '' : book.imageSource || '';
    book.amazonUrl = snapshot.amazonUrl || book.amazonUrl;
    book.previousEffectivePrice = previousEffectivePrice;
    book.currentPrice = snapshot.currentPrice;
    book.currentPoints = snapshot.currentPoints;
    book.effectivePrice = snapshot.effectivePrice;
    book.listPrice = snapshot.listPrice ?? book.listPrice;
    book.lowestPrice =
      snapshot.currentPrice == null
        ? book.lowestPrice
        : book.lowestPrice == null
          ? snapshot.currentPrice
          : Math.min(book.lowestPrice, snapshot.currentPrice);
    book.lowestEffectivePrice =
      snapshot.effectivePrice == null
        ? book.lowestEffectivePrice
        : book.lowestEffectivePrice == null
          ? snapshot.effectivePrice
          : Math.min(book.lowestEffectivePrice, snapshot.effectivePrice);
    book.provider = snapshot.provider;
    book.lastCheckedAt = now;
    book.updatedAt = now;
    book.lastError = '';
    updated = true;
    repairStoredBookTitle(book);

    appendPriceHistoryEntry(store, book, now);
    if (repairSuspiciousPriceState(book, store).changed) {
      updated = true;
    }

    publicResult = publicBook(book);
    return store;
  });

  return { updated, book: publicResult || publicBook(await findBookById(id)) };
}

async function detectCollectionSeries(input, options = {}) {
  return fetchSeriesCandidates(input, {
    ...options,
    requireCollectionPage: true,
    allowReaderFallback: false,
    skipExternalFallback: true
  });
}

async function fetchSeriesCandidates(input, options = {}) {
  const candidates = [];

  try {
    const series = await fetchKindleSeriesItems(input, options);
    if (series.items.length > 1) candidates.push(series);
  } catch {
    // Fall back below.
  }

  if (!options.skipExternalFallback) {
    try {
      const series = await fetchExternalKindleSeriesItems(input, options);
      if (series?.items?.length > 1) candidates.push(series);
    } catch {
      // No usable external fallback.
    }

    const saleBonNames = new Set(seriesNamesForSaleBon(candidates));
    if (saleBonNames.size === 0) {
      for (const seriesName of await sourceSeriesNamesForSaleBon(input, options)) saleBonNames.add(seriesName);
    }

    for (const seriesName of saleBonNames) {
      try {
        const series = await fetchSaleBonKindleSeriesItems(seriesName, { sourceAsin: extractAsin(input) });
        if (series?.items?.length > 1) candidates.push(series);
      } catch {
        // Sale-bon is an optional fallback; ignore failures and use the other candidates.
      }
    }

    const sourceAsin = extractAsin(input);
    const kintyakuQueries = supplementalSeriesQueries(candidates, saleBonNames);
    for (const { query, seriesName } of kintyakuQueries) {
      try {
        const series = await fetchKintyakuKindleSeriesItems(query, { sourceAsin, seriesName });
        if (series?.items?.length > 1) candidates.push(series);
      } catch {
        // Kintyaku is an optional metadata source; ignore failures and use the other candidates.
      }
    }

    const efoxQueries = supplementalSeriesQueries(candidates, saleBonNames);
    for (const { query, seriesName } of efoxQueries) {
      try {
        const series = await fetchEfoxKindleSeriesItems(query, { sourceAsin, seriesName });
        if (series?.items?.length > 1) candidates.push(series);
      } catch {
        // efox is an optional article source; ignore failures and use the other candidates.
      }
    }

    const kinpomeQueries = supplementalSeriesQueries(candidates, saleBonNames);
    for (const { query, seriesName } of kinpomeQueries) {
      try {
        const series = await fetchKinpomeKindleSeriesItems(query, { sourceAsin, seriesName });
        if (series?.items?.length > 1) candidates.push(series);
      } catch {
        // Kinpome is an optional price source; ignore failures and use the other candidates.
      }
    }
  }

  if (candidates.length === 0) return null;
  const usableCandidates = filterSuspiciousSeriesCandidates(candidates);
  if (usableCandidates.length === 0) return null;
  const merged = usableCandidates.reduce((result, series) => mergeSeriesCandidate(result, series));
  const resolved = options.skipBackfill
    ? withSeriesReconciliation(merged)
    : await resolveSeriesCandidateDiffs(merged, usableCandidates);
  if (!isIncompleteSeriesCandidate(resolved)) return resolved;
  return options.allowIncomplete && resolved.items.length > 1 ? resolved : null;
}

function filterSuspiciousSeriesCandidates(candidates) {
  const alternatives = candidates.filter((series) => !isMostlyAmazonBulkSeriesCandidate(series));
  return candidates.filter((series) => !isSuspiciousAmazonBulkSeriesCandidate(series, alternatives));
}

function isSuspiciousAmazonBulkSeriesCandidate(series, alternatives = []) {
  if (!isMostlyAmazonBulkSeriesCandidate(series)) return false;
  const prices = seriesPriceValues(series);
  const medianPrice = medianNumber(prices);
  if (!Number.isFinite(medianPrice) || medianPrice <= 0 || medianPrice > SINGLE_EPISODE_SERIES_PRICE_MAX) {
    return false;
  }

  const items = Array.isArray(series?.items) ? series.items : [];
  const expected = Number(series?.expectedVolumeCount) || 0;
  const countMismatch = expected > 0 && items.length > Math.max(expected * 2, expected + 5);
  const betterAlternative = alternatives.some((candidate) => isBetterNonBulkAlternative(series, candidate));

  return betterAlternative || (countMismatch && items.length >= SUSPICIOUS_BULK_SERIES_COUNT_MIN);
}

function isMostlyAmazonBulkSeriesCandidate(series) {
  const items = Array.isArray(series?.items) ? series.items : [];
  if (items.length === 0) return false;
  const bulkItems = items.filter((item) => String(item?.provider || '').toLowerCase() === 'amazon_series_bulk');
  return bulkItems.length / items.length >= 0.75;
}

function isBetterNonBulkAlternative(series, candidate) {
  const items = Array.isArray(series?.items) ? series.items : [];
  const candidateItems = Array.isArray(candidate?.items) ? candidate.items : [];
  if (candidateItems.length < 2 || candidateItems.length >= items.length) return false;
  if (!isSameNamedSeries(series, candidate)) return false;

  const candidateVolumes = candidateItems.map(seriesItemVolume).filter((volume) => volume > 0);
  const candidateExpected = Number(candidate?.expectedVolumeCount) || 0;
  const candidateLooksComplete =
    candidateExpected > 0
      ? candidateItems.length >= Math.min(candidateExpected, Math.max(...candidateVolumes, 0))
      : candidateVolumes.length >= candidateItems.length;
  return candidateLooksComplete;
}

function isSameNamedSeries(left, right) {
  const leftName = normalizeSeriesNameForComparison(left?.seriesName);
  const rightName = normalizeSeriesNameForComparison(right?.seriesName);
  return Boolean(leftName && rightName && leftName === rightName);
}

function normalizeSeriesNameForComparison(value) {
  return String(value || '')
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

function seriesPriceValues(series) {
  return (Array.isArray(series?.items) ? series.items : [])
    .map((item) => Number(item?.currentPrice))
    .filter((price) => Number.isFinite(price) && price > 0);
}

function medianNumber(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function seriesNamesForSaleBon(candidates) {
  return [
    ...new Set(
      candidates
        .map((series) => String(series?.seriesName || '').trim())
        .filter((name) => name && name !== 'Kindle シリーズ')
    )
  ];
}

function seriesQueriesForSupplementalSources(candidates) {
  const queries = new Map();
  for (const seriesName of seriesNamesForSaleBon(candidates)) {
    queries.set(`${seriesName}\n${seriesName}`, { query: seriesName, seriesName });
  }

  for (const candidate of candidates) {
    const seriesName = String(candidate?.seriesName || '').trim();
    if (!seriesName || seriesName === 'Kindle シリーズ') continue;

    for (const item of candidate.items || []) {
      const author = String(item.author || '').split(',')[0].trim();
      if (!author) continue;
      queries.set(`${seriesName}\n${author}`, { query: author, seriesName });
      if (queries.size >= 8) return [...queries.values()];
    }
  }

  return [...queries.values()].slice(0, 8);
}

function supplementalSeriesQueries(candidates, fallbackSeriesNames = new Set()) {
  const queries = seriesQueriesForSupplementalSources(candidates);
  if (queries.length > 0) return queries;

  return [...fallbackSeriesNames]
    .map((seriesName) => ({ query: seriesName, seriesName }))
    .filter((item) => item.query && item.seriesName)
    .slice(0, 8);
}

async function sourceSeriesNamesForSaleBon(input, options = {}) {
  const asin = extractAsin(input);
  if (!asin) return [];
  const names = new Set(seriesNameCandidatesFromAmazonSlug(input));

  try {
    const snapshot = await fetchBookSnapshot(asin, {
      url: input,
      signal: options.signal,
      timeoutMs: options.timeoutMs
    });
    for (const seriesName of seriesNameCandidatesFromBookTitle(snapshot.title)) names.add(seriesName);
  } catch {
    // URL slug candidates remain useful when Amazon product/search pages are blocked.
  }

  return [...names].slice(0, 8);
}

function seriesNameCandidatesFromBookTitle(title) {
  const cleaned = cleanBookTitleForSeriesName(title);
  const withoutImprint = stripTrailingImprint(cleaned);
  const candidates = [stripVolumeSuffix(withoutImprint), stripVolumeSuffix(cleaned), withoutImprint, cleaned]
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value && !/^ASIN\s+[A-Z0-9]{10}$/i.test(value))
    .filter((value) => value !== 'Kindle シリーズ');
  return [...new Set(candidates)];
}

function seriesNameCandidatesFromAmazonSlug(input) {
  let pathname = '';
  try {
    pathname = decodeURIComponent(new URL(String(input || '')).pathname);
  } catch {
    return [];
  }

  const parts = pathname.split('/').filter(Boolean);
  const dpIndex = parts.findIndex((part, index) => /^dp$/i.test(part) && /^[A-Z0-9]{10}$/i.test(parts[index + 1] || ''));
  const gpIndex = parts.findIndex(
    (part, index) => /^gp$/i.test(part) && /^product$/i.test(parts[index + 1] || '') && /^[A-Z0-9]{10}$/i.test(parts[index + 2] || '')
  );
  const markerIndex = dpIndex >= 0 ? dpIndex : gpIndex;
  const slug = markerIndex > 0 ? parts[markerIndex - 1] : '';
  if (!slug || /^[A-Z0-9]{10}$/i.test(slug)) return [];

  const tokens = slug
    .split(/[-_]+/)
    .map((part) => cleanBookTitleForSeriesName(part))
    .filter((part) => part && !/^(?:ebook|kindle|amazon|jp|co)$/i.test(part));
  const candidates = [];
  for (let length = 1; length <= Math.min(tokens.length, 5); length += 1) {
    candidates.push(stripVolumeSuffix(stripTrailingImprint(tokens.slice(0, length).join(' '))));
  }
  candidates.push(stripVolumeSuffix(stripTrailingImprint(tokens.join(' '))));

  return [...new Set(candidates.map((value) => value.trim()).filter(Boolean))];
}

function cleanBookTitleForSeriesName(title) {
  return String(title || '')
    .replace(/\s+\|.*$/, '')
    .replace(/\s*-\s*Amazon.*$/i, '')
    .replace(/\s*\(Kindle版\)\s*$/i, '')
    .replace(/\s*\[Kindle版\]\s*$/i, '')
    .trim();
}

function stripTrailingImprint(title) {
  let value = String(title || '').trim();
  for (let index = 0; index < 2; index += 1) {
    const next = value
      .replace(/\s*[（(][^（）()]{0,80}(?:コミックス|コミック|文庫|新書|DX|KC|REX|ZERO-SUM|モーニング|イブニング|アフタヌーン|ビッグ|スピリッツ|ジャンプ|マガジン|サンデー|チャンピオン|ヒーローズ|A\.?L\.?C\.?|L\.?C\.?|ebook|Kindle)[^（）()]{0,80}[）)]\s*$/i, '')
      .trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

function stripVolumeSuffix(title) {
  let value = String(title || '').trim();
  for (let index = 0; index < 3; index += 1) {
    const next = value
      .replace(/\s*[（(]\s*(?:第\s*)?[0-9０-９]{1,3}\s*(?:巻)?\s*[）)]\s*$/i, '')
      .replace(/\s*(?:第\s*)?[0-9０-９]{1,3}\s*巻\s*$/i, '')
      .replace(/\s+[0-9０-９]{1,3}\s*$/i, '')
      .replace(/\s*[（(]\s*(?:上|中|下|前|後|前編|後編|上巻|中巻|下巻)\s*[）)]\s*$/i, '')
      .replace(/\s*(?:上巻|中巻|下巻|前編|後編)\s*$/i, '')
      .trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

function mergeSeriesCandidate(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;

  const base = primary.items.length >= secondary.items.length ? primary : secondary;
  const overlay = base === primary ? secondary : primary;
  const overlayItems = new Map(overlay.items.map((item) => [item.asin, item]));
  const used = new Set();

  const items = base.items.map((item) => {
    used.add(item.asin);
    return mergeSeriesItemSeed(item, overlayItems.get(item.asin));
  });

  for (const item of overlay.items) {
    if (!used.has(item.asin)) items.push(item);
  }

  return {
    ...base,
    seriesName: base.seriesName || overlay.seriesName,
    sourceAsin: base.sourceAsin || overlay.sourceAsin,
    sourcePriceSeed: base.sourcePriceSeed || overlay.sourcePriceSeed,
    completed: Boolean(base.completed || overlay.completed),
    expectedVolumeCount: Math.max(
      Number(base.expectedVolumeCount) || 0,
      Number(overlay.expectedVolumeCount) || 0,
      maxSeriesItemVolume(items),
      items.length
    ),
    provider: [base.provider, overlay.provider].filter(Boolean).join('+') || base.provider,
    items
  };
}

function applySeriesDiscoveryMetadata(book, options = {}) {
  const now = options.now || new Date().toISOString();
  book.seriesLastDiscoveredAt = now;
  book.seriesDiscoveryError = options.error || '';
  book.seriesDiscoveryStatus = options.error ? 'error' : 'checked';
  book.seriesDiscoverySkipReason = '';
  book.seriesDiscoverySkippedAt = '';
  if (options.completed) {
    book.seriesCompleted = true;
    book.seriesCompletedAt = book.seriesCompletedAt || now;
  }
}

function isIncompleteSeriesCandidate(series) {
  const items = Array.isArray(series?.items) ? series.items : [];
  const expected = Math.max(Number(series?.expectedVolumeCount) || 0, maxSeriesItemVolume(items), items.length);
  return seriesCompletenessErrors(items, expected).length > 0;
}

function mergeSeriesItemSeed(base, overlay) {
  if (!overlay) return base;

  const priceSeed = chooseSeriesPriceSeed(base, overlay);
  const imageSeed = chooseSeriesImageSeed(base, overlay);
  const currentPrice = priceSeed?.currentPrice ?? null;
  const provider = priceSeed?.provider || base.provider || overlay.provider;
  const listPrice = trustedListPriceFor(currentPrice, priceSeed?.listPrice ?? overlay.listPrice ?? base.listPrice, provider);
  return {
    ...base,
    title: base.title || overlay.title,
    imageUrl: imageSeed?.imageUrl || '',
    imageSource: imageSeed?.imageSource || (imageSeed?.imageUrl ? imageSeed.provider || '' : ''),
    author: base.author || overlay.author || '',
    publisher: base.publisher || overlay.publisher || '',
    volume: seriesItemVolume(base) || seriesItemVolume(overlay),
    currentPrice,
    currentPoints: priceSeed?.currentPoints ?? 0,
    effectivePrice: priceSeed?.effectivePrice ?? effectivePriceFromSeed(priceSeed || {}),
    listPrice,
    provider,
    lastError: currentPrice == null ? overlay.lastError || base.lastError || '' : ''
  };
}

function chooseSeriesPriceSeed(base, overlay) {
  const candidates = [base, overlay].filter(
    (item) => item?.currentPrice != null && !isUnvalidatedSeriesPriceProvider(item.provider)
  );
  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => seriesPriceProviderRank(right.provider) - seriesPriceProviderRank(left.provider))[0];
}

function chooseSeriesImageSeed(base, overlay) {
  const candidates = [base, overlay].filter((item) => item?.imageUrl);
  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => seriesImageProviderRank(right.provider) - seriesImageProviderRank(left.provider))[0];
}

async function resolveSeriesCandidateDiffs(series, candidates) {
  const diffAsins = findSeriesCandidateDiffAsins(candidates);
  if (diffAsins.size === 0 && !hasSeriesItemsNeedingBackfill(series.items)) {
    return withSeriesReconciliation(series, {
      diffAsins,
      enriched: 0,
      errors: []
    });
  }

  const itemsByAsin = new Map(series.items.map((item) => [item.asin, { ...item }]));
  const candidateItemsByAsin = collectCandidateItemsByAsin(candidates);
  const useSourcePriceFallback = shouldUseSourcePriceFallback(series, itemsByAsin);
  const errors = [];
  let enriched = 0;

  for (const asin of diffAsins) {
    const seeds = candidateItemsByAsin.get(asin) || [];
    let merged = itemsByAsin.get(asin) || seeds[0];
    for (const seed of seeds) {
      merged = mergeSeriesItemSeed(merged, seed);
    }
    if (merged) itemsByAsin.set(asin, merged);
  }

  const backfillTargets = seriesBackfillTargets(itemsByAsin, diffAsins);
  const backfillLimit = floorNumber(
    process.env.SERIES_BACKFILL_LIMIT ?? process.env.SERIES_PRICE_BACKFILL_LIMIT,
    1,
    120
  );
  const limitedTargets = backfillTargets.slice(0, backfillLimit);
  if (backfillTargets.length > limitedTargets.length) {
    errors.push(`series price backfill limited: ${limitedTargets.length}/${backfillTargets.length} attempted`);
  }

  for (const asin of limitedTargets) {
    const item = itemsByAsin.get(asin);
    if (!item || !seriesItemNeedsBackfill(item, weakSeriesImageUrls([...itemsByAsin.values()]))) continue;

    try {
      const snapshot = await fetchAmazonHtmlSnapshotForSeriesBackfill(asin, item);
      const next = mergeAmazonSnapshotIntoSeriesItem(item, snapshot);
      if (next.currentPrice == null) {
        next.lastError = 'シリーズ価格補完: Amazon HTMLで価格を取得できませんでした';
        errors.push(`${asin}: price not found`);
      } else if (isWeakSeriesImage(next, weakSeriesImageUrls([...itemsByAsin.values()]))) {
        errors.push(`${asin}: image not found`);
      } else {
        enriched += 1;
      }
      itemsByAsin.set(asin, next);
    } catch (error) {
      item.provider = item.provider || 'series_diff_pending';
      item.lastError = `シリーズ価格補完: Amazon HTMLで価格補完できませんでした (${error.message})`;
      errors.push(`${asin}: ${error.message}`);
    }
  }

  if (useSourcePriceFallback) {
    const fallbackSeed = sourcePriceFallbackSeed(itemsByAsin, series.sourcePriceSeed);
    const sourceFilled = fallbackSeed ? applySourcePriceFallback(itemsByAsin, fallbackSeed) : 0;
    if (sourceFilled > 0) {
      enriched += sourceFilled;
    }
  }

  return withSeriesReconciliation({
    ...series,
    items: [...itemsByAsin.values()]
  }, {
    diffAsins,
    enriched,
    errors
  });
}

function withSeriesReconciliation(series, metadata = {}) {
  const items = [...(series.items || [])].sort(compareSeriesItemSeeds);
  const expectedVolumeCount = Math.max(
    Number(series.expectedVolumeCount) || 0,
    maxSeriesItemVolume(items),
    items.length
  );
  const errors = [
    ...(metadata.errors || []),
    ...seriesCompletenessErrors(items, expectedVolumeCount)
  ];

  return {
    ...series,
    expectedVolumeCount,
    items,
    reconciliation: {
      diffAsins: [...(metadata.diffAsins || [])],
      enriched: metadata.enriched || 0,
      unresolvedAsins: items.filter((item) => item.currentPrice == null).map((item) => item.asin),
      errors: [...new Set(errors)]
    }
  };
}

function seriesCompletenessErrors(items, expectedVolumeCount) {
  const expected = Number(expectedVolumeCount) || 0;
  if (!expected || !Array.isArray(items) || items.length === 0) return [];

  const volumes = new Set(
    items.map(seriesItemVolume).filter((value) => Number.isFinite(value) && value > 0)
  );
  const missingVolumes = [];
  for (let volume = 1; volume <= expected; volume += 1) {
    if (!volumes.has(volume)) missingVolumes.push(volume);
  }

  if (expected <= items.length && missingVolumes.length === 0) return [];

  const missingText = missingVolumes.length
    ? `; missing volumes ${compactNumberRanges(missingVolumes).join(',')}`
    : '';
  return [`series incomplete: ${items.length}/${expected} books resolved${missingText}`];
}

function compactNumberRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right);
  const ranges = [];
  for (let index = 0; index < sorted.length;) {
    const start = sorted[index];
    let end = start;
    while (sorted[index + 1] === end + 1) {
      index += 1;
      end = sorted[index];
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    index += 1;
  }
  return ranges;
}

function shouldUseSourcePriceFallback(series, itemsByAsin) {
  const sourcePrice = series?.sourcePriceSeed?.currentPrice;
  if (sourcePrice == null) return false;
  if (!Number.isFinite(Number(sourcePrice)) || Number(sourcePrice) <= 0) return false;
  if (isUnvalidatedSeriesPriceProvider(series.sourcePriceSeed?.provider)) return false;

  const items = [...itemsByAsin.values()];
  if (items.length === 0) return false;
  if (items.some((item) => item.currentPrice != null)) return false;

  const maxCount = floorNumber(process.env.SERIES_SOURCE_PRICE_FALLBACK_MAX_COUNT, 1, 12);
  const expectedCount = Math.max(Number(series?.expectedVolumeCount) || 0, maxSeriesItemVolume(items), items.length);
  if (expectedCount > maxCount || items.length > maxCount) return false;

  return true;
}

function applySourcePriceFallback(itemsByAsin, sourcePriceSeed) {
  let filled = 0;
  for (const item of itemsByAsin.values()) {
    if (!item?.asin || item.currentPrice != null) continue;
    item.currentPrice = sourcePriceSeed.currentPrice;
    item.currentPoints = sourcePriceSeed.currentPoints ?? 0;
    item.effectivePrice = sourcePriceSeed.effectivePrice ?? effectivePriceFromSeed(sourcePriceSeed);
    item.listPrice = sourcePriceSeed.listPrice ?? item.listPrice ?? null;
    item.provider = sourcePriceSeed.provider || 'amazon_series_source_price';
    item.lastError = '';
    filled += 1;
  }
  return filled;
}

function sourcePriceFallbackSeed(itemsByAsin, sourcePriceSeed) {
  const sourcePrice = sourcePriceSeed?.currentPrice;
  if (sourcePrice == null) return null;

  const pricedItems = [...itemsByAsin.values()].filter((item) => item.currentPrice != null);
  const mismatchedPrice = pricedItems.some((item) => Number(item.currentPrice) !== Number(sourcePrice));
  if (mismatchedPrice) return null;
  if (isUnvalidatedSeriesPriceProvider(sourcePriceSeed?.provider)) return null;

  const representative = pricedItems.find((item) => item.currentPoints != null || item.effectivePrice != null);
  if (!representative) return null;

  return {
    ...sourcePriceSeed,
    currentPoints: representative.currentPoints ?? sourcePriceSeed.currentPoints ?? 0,
    effectivePrice: representative.effectivePrice ?? effectivePriceFromSeed(representative)
  };
}

function hasSeriesItemsNeedingBackfill(items = []) {
  const weakImageUrls = weakSeriesImageUrls(items);
  return items.some((item) => item?.asin && seriesItemNeedsBackfill(item, weakImageUrls));
}

function seriesBackfillTargets(itemsByAsin, diffAsins) {
  const items = [...itemsByAsin.values()];
  const weakImageUrls = weakSeriesImageUrls(items);
  return [...itemsByAsin.values()]
    .filter((item) => item?.asin && seriesItemNeedsBackfill(item, weakImageUrls))
    .sort((left, right) => {
      const leftDiff = diffAsins.has(left.asin) ? 0 : 1;
      const rightDiff = diffAsins.has(right.asin) ? 0 : 1;
      if (leftDiff !== rightDiff) return leftDiff - rightDiff;
      return compareSeriesItemSeeds(left, right);
    })
    .map((item) => item.asin);
}

function seriesItemNeedsBackfill(item, weakImageUrls) {
  return item.currentPrice == null || isUnvalidatedSeriesPriceProvider(item.provider) || isWeakSeriesImage(item, weakImageUrls);
}

function isWeakSeriesImage(item, weakImageUrls) {
  if (!item?.imageUrl) return true;
  if (item.imageSource === 'series_fallback') return true;
  return weakImageUrls.has(normalizeImageUrl(item.imageUrl));
}

function weakSeriesImageUrls(items = []) {
  const counts = new Map();
  for (const item of items) {
    const normalized = normalizeImageUrl(item?.imageUrl);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([url]) => url));
}

async function fetchAmazonHtmlSnapshotForSeriesBackfill(asin, seed = {}) {
  const attempts = floorNumber(process.env.SERIES_PRICE_BACKFILL_ATTEMPTS, 1, 2);
  let lastSnapshot = null;
  let lastError = null;

  for (const url of seriesBackfillUrls(asin)) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const snapshot = await fetchAmazonHtmlSnapshot(asin, url, seed);
        if (snapshot.currentPrice != null) return snapshot;
        lastSnapshot = snapshot;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (lastSnapshot) return lastSnapshot;
  throw lastError || new Error('Amazon HTMLで価格補完できませんでした');
}

function seriesBackfillUrls(asin) {
  const base = amazonUrlForAsin(asin);
  const urls = [base];

  try {
    const kindleUrl = new URL(base);
    kindleUrl.searchParams.set('binding', 'kindle_edition');
    kindleUrl.searchParams.set('ref', 'dbs_mng_crcw_0');
    urls.push(kindleUrl.toString());

    const productUrl = new URL(base);
    productUrl.pathname = `/gp/product/${asin}`;
    productUrl.searchParams.set('storeType', 'ebooks');
    urls.push(productUrl.toString());
  } catch {
    // Keep the base URL fallback.
  }

  return [...new Set(urls)];
}

function findSeriesCandidateDiffAsins(candidates) {
  if (candidates.length < 2) return new Set();

  const appearances = new Map();
  for (const candidate of candidates) {
    const asins = new Set(candidate.items.map((item) => item.asin).filter(Boolean));
    for (const asin of asins) {
      appearances.set(asin, (appearances.get(asin) || 0) + 1);
    }
  }

  return new Set([...appearances.entries()].filter(([, count]) => count !== candidates.length).map(([asin]) => asin));
}

function collectCandidateItemsByAsin(candidates) {
  const itemsByAsin = new Map();
  for (const candidate of candidates) {
    for (const item of candidate.items) {
      if (!item.asin) continue;
      const items = itemsByAsin.get(item.asin) || [];
      items.push(item);
      itemsByAsin.set(item.asin, items);
    }
  }
  return itemsByAsin;
}

function mergeAmazonSnapshotIntoSeriesItem(item, snapshot) {
  const useSnapshotPrice = shouldUseAmazonSnapshotPriceForSeriesItem(item, snapshot);
  const currentPrice = useSnapshotPrice ? snapshot.currentPrice : item.currentPrice;
  const provider = useSnapshotPrice ? snapshot.provider || item.provider : item.provider || snapshot.provider;
  const listPrice = trustedListPriceFor(
    currentPrice,
    useSnapshotPrice ? snapshot.listPrice ?? item.listPrice ?? null : item.listPrice ?? snapshot.listPrice ?? null,
    provider
  );
  return {
    ...item,
    title: preferSnapshotText(snapshot.title, item.title),
    author: snapshot.author || item.author || '',
    publisher: snapshot.publisher || item.publisher || '',
    imageUrl: snapshot.imageUrl || item.imageUrl || '',
    imageSource: snapshot.imageUrl ? snapshot.provider || 'amazon_html' : item.imageSource || '',
    amazonUrl: snapshot.amazonUrl || item.amazonUrl || amazonUrlForAsin(item.asin),
    currentPrice,
    currentPoints: useSnapshotPrice ? snapshot.currentPoints ?? 0 : item.currentPoints ?? 0,
    effectivePrice: useSnapshotPrice ? snapshot.effectivePrice ?? effectivePriceFromSeed(snapshot) : item.effectivePrice,
    listPrice,
    provider,
    lastError: currentPrice == null ? item.lastError || '' : ''
  };
}

function shouldUseAmazonSnapshotPriceForSeriesItem(item, snapshot) {
  if (snapshot.currentPrice == null) return false;
  if (item.currentPrice == null) return true;
  if (!isExternalSeriesPriceProvider(item.provider)) return true;

  const current = Number(item.currentPrice);
  const next = Number(snapshot.currentPrice);
  if (!Number.isFinite(current) || !Number.isFinite(next) || current <= 0 || next <= 0) return true;

  const ratio = next / current;
  return ratio >= 0.5 && ratio <= 1.5;
}

function isExternalSeriesPriceProvider(provider) {
  return [
    'sale_bon_series',
    'efox',
    'efox_series',
    'kintyaku',
    'kintyaku_series',
    'kinpome',
    'kinpome_series',
    'external_series'
  ].includes(String(provider || '').toLowerCase());
}

function updateExistingSeriesBook(book, item, options) {
  let changed = false;

  if (options.seriesKey && book.seriesKey !== options.seriesKey) {
    book.seriesKey = options.seriesKey;
    changed = true;
  }
  if (options.seriesName && book.seriesName !== options.seriesName) {
    book.seriesName = options.seriesName;
    changed = true;
  }
  if (
    options.seriesExpectedCount &&
    Number(book.seriesExpectedCount || 0) !== Number(options.seriesExpectedCount)
  ) {
    book.seriesExpectedCount = options.seriesExpectedCount;
    changed = true;
  }
  if (options.sourceUrl && book.sourceUrl !== options.sourceUrl) {
    book.sourceUrl = options.sourceUrl;
    changed = true;
  }
  if (book.importMode !== 'kindle_series') {
    book.importMode = 'kindle_series';
    changed = true;
  }
  if (options.volume && String(book.volume || '') !== String(options.volume)) {
    book.volume = options.volume;
    changed = true;
  }
  if (item.amazonUrl && !book.amazonUrl) {
    book.amazonUrl = item.amazonUrl;
    changed = true;
  }
  if (shouldRefreshSeriesTitle(book, item)) {
    book.title = item.title;
    changed = true;
  }
  if (shouldRefreshSeriesImage(book, item, options)) {
    book.imageUrl = item.imageUrl;
    book.imageSource = item.imageSource || item.provider || '';
    changed = true;
  }
  if (shouldRefreshSeriesPrice(book, item)) {
    const correctingImplausiblePrice = isImplausibleStoredSeriesPrice(book, item);
    const effectivePrice = item.effectivePrice ?? effectivePriceFromSeed(item);
    const provider = item.provider || book.provider;
    const listPrice = trustedListPriceFor(item.currentPrice, item.listPrice, provider);
    book.currentPrice = item.currentPrice;
    book.currentPoints = item.currentPoints ?? 0;
    book.effectivePrice = effectivePrice;
    book.lowestPrice = book.lowestPrice == null ? item.currentPrice : Math.min(book.lowestPrice, item.currentPrice);
    if (effectivePrice != null) {
      book.lowestEffectivePrice =
        book.lowestEffectivePrice == null ? effectivePrice : Math.min(book.lowestEffectivePrice, effectivePrice);
    }
    if (shouldIgnoreListPriceForProvider(book.currentPrice, book.listPrice, provider)) book.listPrice = null;
    if (listPrice != null && book.listPrice == null) book.listPrice = listPrice;
    if (item.provider) book.provider = item.provider;
    book.lastCheckedAt = book.lastCheckedAt || options.now;
    book.lastError = '';
    if (correctingImplausiblePrice) repairImplausibleSeriesPriceHistory(book, options.store);
    changed = true;
  }
  if (
    book.currentPrice != null &&
    item.currentPrice != null &&
    (/価格補完/.test(book.lastError || '') || isTransientSnapshotError(book.lastError))
  ) {
    book.lastError = '';
    changed = true;
  }
  if (hasImplausibleSeriesPriceHistory(book, options.store) || hasImplausibleSeriesPriceFloor(book)) {
    repairImplausibleSeriesPriceHistory(book, options.store);
    changed = true;
  }
  if (shouldClearUnvalidatedSourcePrice(book, item)) {
    book.currentPrice = null;
    book.currentPoints = 0;
    book.effectivePrice = null;
    if (item.provider) book.provider = item.provider;
    book.lastError = item.lastError || 'シリーズ価格補完: 単巻価格として検証できませんでした';
    changed = true;
  }
  if (book.currentPrice == null && item.lastError && book.lastError !== item.lastError) {
    book.lastError = item.lastError;
    changed = true;
  }

  if (changed) book.updatedAt = options.now;
  return changed;
}

function shouldRefreshSeriesImage(book, item, options = {}) {
  if (!item.imageUrl) return false;
  if (!book.imageUrl) return true;
  if (normalizeImageUrl(book.imageUrl) === normalizeImageUrl(item.imageUrl)) return false;
  const weakImageUrls = options.weakImageUrls || new Set();
  const bookImageIsWeak = weakImageUrls.has(normalizeImageUrl(book.imageUrl));
  const itemImageIsWeak = item.imageSource === 'series_fallback' || weakImageUrls.has(normalizeImageUrl(item.imageUrl));
  if (bookImageIsWeak && !itemImageIsWeak) return true;
  if (seriesImageProviderRank(item.provider) > seriesImageProviderRank(book.provider)) return true;
  return book.provider === 'curated_series';
}

function shouldRefreshSeriesTitle(book, item) {
  if (!item.title) return false;
  if (isClearlyDifferentSeriesTitle(item.title, book.seriesName || item.seriesName)) return false;
  if (/^ASIN\s+[A-Z0-9]{10}$/i.test(book.title || '')) return true;
  if (isAmazonErrorPageBookTitle(book.title)) return true;

  const bookVolume = volumeFromSeriesTitle(book.title);
  const itemVolume = seriesItemVolume(item);
  if (bookVolume && itemVolume && bookVolume !== itemVolume) return true;

  return book.provider === 'curated_series' && item.provider && item.provider !== 'curated_series' && book.title !== item.title;
}

function shouldRefreshSeriesPrice(book, item) {
  if (item.currentPrice == null) return false;
  if (isUnvalidatedSeriesPriceProvider(item.provider)) return false;
  if (isUnverifiedFreeSeriesPriceProvider(item.provider, item.currentPrice)) return false;
  if (book.currentPrice == null) return true;
  if (book.currentPrice === 0 && item.currentPrice > 0) return true;
  if (isImplausibleStoredSeriesPrice(book, item)) return true;
  if (seriesPriceProviderRank(item.provider) > seriesPriceProviderRank(book.provider)) return true;
  if (
    seriesPriceProviderRank(item.provider) === seriesPriceProviderRank(book.provider) &&
    isRefreshableSeriesPriceProvider(item.provider) &&
    (Number(book.currentPrice) !== Number(item.currentPrice) ||
      Number(book.currentPoints || 0) !== Number(item.currentPoints || 0))
  ) {
    return true;
  }
  return book.provider === 'curated_series' && item.provider && item.provider !== 'curated_series';
}

function isImplausibleStoredSeriesPrice(book, item) {
  if (book.currentPrice == null || item.currentPrice == null) return false;
  const listPrice = Number(book.listPrice ?? item.listPrice);
  if (Number.isFinite(listPrice) && listPrice > 0 && Number(book.currentPrice) > listPrice * 1.15) return true;
  const currentPoints = Number(book.currentPoints || 0);
  return currentPoints > Number(book.currentPrice);
}

function repairImplausibleSeriesPriceHistory(book, store) {
  if (!store || !book?.id) return;
  repairSuspiciousPriceState(book, store);
}

function hasImplausibleSeriesPriceHistory(book, store) {
  return Boolean(
    store &&
      book?.id &&
      book.currentPrice != null &&
      store.priceHistory.some((entry) => entry.bookId === book.id && isImplausibleSeriesHistoryEntry(entry, book))
  );
}

function hasImplausibleSeriesPriceFloor(book) {
  if (!book || book.currentPrice == null) return false;
  const floor = Number(book.lowestPrice);
  const listPrice = Number(book.listPrice);
  if (!Number.isFinite(floor) || floor <= 0) return false;
  return Number.isFinite(listPrice) && listPrice > 0 && floor > listPrice * 1.15;
}

function isImplausibleSeriesHistoryEntry(entry, book) {
  if (String(entry.provider || '').toLowerCase() !== 'amazon_html') return false;
  const historyPrice = Number(entry.price);
  const listPrice = Number(book.listPrice);
  if (!Number.isFinite(historyPrice) || historyPrice <= 0) return false;
  if (Number(entry.points || 0) > historyPrice) return true;
  return Number.isFinite(listPrice) && listPrice > 0 && historyPrice > listPrice * 1.15;
}

function shouldClearUnvalidatedSourcePrice(book, item) {
  return (
    hasUnvalidatedSeriesPrice(book) &&
    item.currentPrice == null &&
    item.lastError
  );
}

function suspiciousSnapshotReason(book, snapshot) {
  return suspiciousPriceReason({
    price: snapshot.currentPrice,
    points: snapshot.currentPoints,
    effectivePrice: snapshot.effectivePrice,
    listPrice: snapshot.listPrice ?? book.listPrice,
    provider: snapshot.provider,
    referencePrices: [
      book.currentPrice,
      book.effectivePrice,
      book.previousEffectivePrice,
      book.listPrice,
      snapshot.listPrice
    ]
  });
}

function isSuspiciousSnapshotError(error) {
  return String(error || '').startsWith('疑わしい価格を無視しました');
}

function isPermanentSnapshotError(error) {
  return /^Kindle版(?:ASIN|商品)ではありません/.test(String(error || ''));
}

function shouldStoreSnapshotError(book, error) {
  if (!error) return false;
  if (isPermanentSnapshotError(error) || isSuspiciousSnapshotError(error)) return true;
  if (isBlockingSnapshotError(error)) return true;
  if (book.currentPrice == null) return true;
  return !isTransientSnapshotError(error);
}

function isTransientSnapshotError(error) {
  return /(?:価格を取得できませんでした|Amazonにブロック|HTTP\s*(?:403|429|500|503)|fetch failed|タイムアウト|reader:|商品ページではなくエラーページ)/i.test(String(error || ''));
}

function isBlockingSnapshotError(error) {
  return /(?:HTTP\s*(?:403|429|503)|Too Many Requests|Forbidden|ServiceUnavailable|サービスが利用できません|Amazonにブロック|captcha|robot check|自動化されたアクセス|ショッピングを続けてください)/i.test(String(error || ''));
}

function repairSuspiciousPriceState(book, store, options = {}) {
  if (!book || !store) {
    return {
      changed: false,
      currentCleared: false,
      currentRestored: false,
      removedHistory: 0,
      removedNotifications: 0
    };
  }

  let changed = false;
  let currentCleared = false;
  let currentRestored = false;

  if (clearUnreliableStoredListPrice(book)) changed = true;

  if (
    book.currentPrice != null &&
    Number(book.currentPrice) > 0 &&
    book.lastError &&
    isTransientSnapshotError(book.lastError) &&
    !isBlockingSnapshotError(book.lastError) &&
    !suspiciousStoredCurrentPriceReason(book)
  ) {
    book.lastError = '';
    changed = true;
  }

  const currentSnapshotBeforeRepair = {
    currentPrice: book.currentPrice,
    currentPoints: book.currentPoints,
    effectivePrice: book.effectivePrice,
    provider: book.provider
  };
  const shouldClearCurrent =
    options.clearCurrent && (suspiciousStoredCurrentPriceReason(book) || hasUnvalidatedSeriesPrice(book));

  if (shouldClearCurrent) {
    book.currentPrice = null;
    book.currentPoints = 0;
    book.effectivePrice = null;
    book.provider = book.provider === 'amazon_html' || isUnvalidatedSeriesPriceProvider(book.provider) ? 'pending' : book.provider;
    currentCleared = true;
    changed = true;
  }

  const beforeHistoryCount = store.priceHistory.length;
  store.priceHistory = store.priceHistory.filter(
    (entry) =>
      entry.bookId !== book.id ||
      (!isSuspiciousHistoryEntry(entry, book) && !isUnvalidatedSeriesPriceHistoryEntry(entry))
  );
  const removedHistory = beforeHistoryCount - store.priceHistory.length;
  if (removedHistory > 0) changed = true;

  if (currentCleared || (options.restoreMissingCurrent && book.currentPrice == null)) {
    const latest = latestValidPriceHistoryEntry(book, store);
    if (latest) {
      book.currentPrice = latest.price;
      book.currentPoints = latest.points || 0;
      book.effectivePrice = latest.effectivePrice ?? effectivePriceFromSeed(latest);
      book.listPrice = latest.listPrice ?? book.listPrice ?? null;
      book.provider = latest.provider || book.provider;
      book.lastCheckedAt = latest.checkedAt || book.lastCheckedAt;
      currentRestored = true;
      changed = true;
    }
  }

  const beforeNotificationCount = store.notifications.length;
  store.notifications = store.notifications.filter(
    (entry) =>
      entry.bookId !== book.id ||
      !(
        isSuspiciousNotificationEntry(entry, book) ||
        (currentCleared &&
          nullableNumber(entry.effectivePrice) != null &&
          nullableNumber(entry.effectivePrice) === nullableNumber(currentSnapshotBeforeRepair.effectivePrice))
      )
  );
  const removedNotifications = beforeNotificationCount - store.notifications.length;
  if (removedNotifications > 0) changed = true;

  if (changed || hasSuspiciousStoredPriceFloor(book)) {
    recomputeBookPriceFloors(book, store);
    changed = true;
  }

  return { changed, currentCleared, currentRestored, removedHistory, removedNotifications };
}

function repairStorePriceState(store, options = {}) {
  if (!store || !Array.isArray(store.books)) {
    return {
      changed: false,
      booksRepaired: 0,
      currentCleared: 0,
      currentRestored: 0,
      removedHistory: 0,
      removedNotifications: 0,
      singleSeriesDemoted: 0
    };
  }

  const now = options.now || new Date().toISOString();
  const summary = {
    changed: false,
    booksRepaired: 0,
    currentCleared: 0,
    currentRestored: 0,
    removedHistory: 0,
    removedNotifications: 0,
    singleSeriesDemoted: 0
  };

  const classificationRepair = repairSingleBookSeriesClassifications(store, { now });
  if (classificationRepair.changed) {
    summary.changed = true;
    summary.singleSeriesDemoted += classificationRepair.demoted;
    summary.removedNotifications += classificationRepair.removedNotifications;
  }

  for (const book of store.books) {
    const repair = repairSuspiciousPriceState(book, store, {
      clearCurrent: options.clearCurrent !== false,
      restoreMissingCurrent: options.restoreMissingCurrent === true
    });
    if (!repair.changed) continue;

    if (repair.currentCleared && !repair.currentRestored) {
      book.lastCheckedAt = null;
      book.lastError ||= '未検証のシリーズ価格を破棄しました。次回チェックで再取得します';
    }

    book.updatedAt = now;
    summary.changed = true;
    summary.booksRepaired += 1;
    summary.currentCleared += repair.currentCleared ? 1 : 0;
    summary.currentRestored += repair.currentRestored ? 1 : 0;
    summary.removedHistory += repair.removedHistory;
    summary.removedNotifications += repair.removedNotifications;
  }

  const compacted = compactPriceHistory(store);
  if (compacted.removed > 0) {
    summary.changed = true;
    summary.removedHistory += compacted.removed;
  }

  const compactedSeries = compactSeriesPriceHistory(store);
  if (compactedSeries.removed > 0) {
    summary.changed = true;
  }

  return summary;
}

function repairSingleBookSeriesClassifications(store, options = {}) {
  const now = options.now || new Date().toISOString();
  const groups = singleBookSeriesRepairGroups(store.books || []);
  const scopes = [];
  let demoted = 0;
  let removedNotifications = 0;

  for (const group of groups) {
    if (!shouldDemoteSingleBookSeriesGroup(group)) continue;
    const book = group.books[0];
    const before = singleBookSeriesState(book);
    demoteBookToSingle(book, { now, sourceUrl: book.sourceUrl });
    scopes.push(...singleBookSeriesScopes(before));
    demoted += 1;
  }

  if (scopes.length > 0) {
    removedNotifications = removeSeriesArtifactsForScopes(store, scopes).removedNotifications;
    compactSeriesPriceHistory(store);
  }

  return {
    changed: demoted > 0,
    demoted,
    removedNotifications
  };
}

function singleBookSeriesRepairGroups(books = []) {
  const groups = new Map();
  for (const book of books) {
    if (!book || (book.importMode !== 'kindle_series' && !book.seriesKey)) continue;
    const key = book.seriesKey || book.sourceUrl || `book:${book.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        books: [],
        expectedCount: 0
      });
    }
    const group = groups.get(key);
    group.books.push(book);
    group.expectedCount = Math.max(group.expectedCount, Number(book.seriesExpectedCount || 0));
  }
  return [...groups.values()];
}

function shouldDemoteSingleBookSeriesGroup(group) {
  if (!group || group.books.length !== 1) return false;
  const expected = Number(group.expectedCount || 0);
  if (expected > 1) return false;
  const book = group.books[0];
  if (!book?.asin) return false;
  if (book.seriesCompleted && expected > 1) return false;
  return expected === 1 || looksLikeStandaloneSeriesBook(book);
}

function looksLikeStandaloneSeriesBook(book) {
  const title = String(book?.title || '').trim();
  const seriesName = String(book?.seriesName || '').trim();
  if (!title) return false;
  if (volumeFromSeriesTitle(title) || Number(book?.volume || 0) > 1) return false;
  if (!seriesName || isGenericSeriesName(seriesName)) return true;
  const titleStem = seriesTitleComparisonStem(title);
  const seriesStem = seriesTitleComparisonStem(seriesName);
  return Boolean(titleStem && seriesStem && (titleStem === seriesStem || titleStem.includes(seriesStem)));
}

function singleBookSeriesState(book) {
  return {
    importMode: book.importMode || 'single',
    seriesKey: book.seriesKey || '',
    seriesName: book.seriesName || '',
    volume: book.volume || '',
    seriesExpectedCount: book.seriesExpectedCount || '',
    sourceUrl: book.sourceUrl || '',
    seriesCompleted: Boolean(book.seriesCompleted),
    seriesCompletedAt: book.seriesCompletedAt || '',
    seriesLastDiscoveredAt: book.seriesLastDiscoveredAt || '',
    seriesDiscoveryStatus: book.seriesDiscoveryStatus || '',
    seriesDiscoverySkipReason: book.seriesDiscoverySkipReason || '',
    seriesDiscoverySkippedAt: book.seriesDiscoverySkippedAt || '',
    seriesDiscoveryError: book.seriesDiscoveryError || '',
    title: book.title || '',
    imageUrl: book.imageUrl || '',
    amazonUrl: book.amazonUrl || ''
  };
}

function demoteBookToSingle(book, options = {}) {
  const now = options.now || new Date().toISOString();
  const sourceUrl = String(options.sourceUrl || book.sourceUrl || book.amazonUrl || amazonUrlForAsin(book.asin)).trim();
  book.importMode = 'single';
  book.seriesKey = '';
  book.seriesName = '';
  book.volume = '';
  book.seriesExpectedCount = '';
  book.seriesCompleted = false;
  book.seriesCompletedAt = '';
  book.seriesLastDiscoveredAt = '';
  book.seriesDiscoveryStatus = '';
  book.seriesDiscoverySkipReason = '';
  book.seriesDiscoverySkippedAt = '';
  book.seriesDiscoveryError = '';
  book.sourceUrl = sourceUrl;
  book.updatedAt = now;
}

function singleBookSeriesScopes(state = {}) {
  const scopes = [];
  if (state.seriesKey) scopes.push({ key: state.seriesKey, seriesKey: state.seriesKey, sourceUrl: state.sourceUrl || '' });
  if (state.sourceUrl) scopes.push({ key: `series:url:${state.sourceUrl}`, seriesKey: '', sourceUrl: state.sourceUrl });
  return scopes;
}

function removeSeriesArtifactsForScopes(store, scopes = []) {
  const keys = new Set(scopes.map((scope) => scope.key).filter(Boolean));
  const seriesKeys = new Set(scopes.map((scope) => scope.seriesKey).filter(Boolean));
  const sourceUrls = new Set(scopes.map((scope) => scope.sourceUrl).filter(Boolean));

  const beforeSeriesHistory = Array.isArray(store.seriesPriceHistory) ? store.seriesPriceHistory.length : 0;
  store.seriesPriceHistory = (store.seriesPriceHistory || []).filter(
    (entry) =>
      !(
        keys.has(entry.key) ||
        keys.has(entry.notificationKey) ||
        seriesKeys.has(entry.seriesKey) ||
        sourceUrls.has(entry.sourceUrl)
      )
  );

  const beforeNotifications = Array.isArray(store.notifications) ? store.notifications.length : 0;
  store.notifications = (store.notifications || []).filter(
    (entry) =>
      !(
        entry.scope === 'series' &&
        (keys.has(entry.notificationKey) || seriesKeys.has(entry.seriesKey) || sourceUrls.has(entry.sourceUrl))
      )
  );

  return {
    removedSeriesHistory: beforeSeriesHistory - store.seriesPriceHistory.length,
    removedNotifications: beforeNotifications - store.notifications.length
  };
}

function hasUnvalidatedSeriesPrice(book) {
  return (
    (isUnvalidatedSeriesPriceProvider(book.provider) || isUnverifiedFreeSeriesPriceProvider(book.provider, book.currentPrice)) &&
    book.currentPrice != null
  );
}

function latestValidPriceHistoryEntry(book, store) {
  return store.priceHistory
    .filter(
      (entry) =>
        entry.bookId === book.id &&
        entry.price != null &&
        !isSuspiciousHistoryEntry(entry, book) &&
        !isUnvalidatedSeriesPriceHistoryEntry(entry)
    )
    .sort((a, b) => new Date(b.checkedAt || 0) - new Date(a.checkedAt || 0))[0] || null;
}

function isUnvalidatedSeriesPriceHistoryEntry(entry) {
  return (
    (isUnvalidatedSeriesPriceProvider(entry?.provider) || isUnverifiedFreeSeriesPriceProvider(entry?.provider, entry?.price)) &&
    entry.price != null
  );
}

function isUnvalidatedSeriesPriceProvider(provider) {
  return UNVALIDATED_SERIES_PRICE_PROVIDERS.has(String(provider || '').toLowerCase());
}

function isUnverifiedFreeSeriesPriceProvider(provider, currentPrice) {
  const price = Number(currentPrice);
  if (!Number.isFinite(price) || price !== 0) return false;
  const normalized = String(provider || '').toLowerCase();
  if (['amazon_html', 'amazon_reader', 'listasin', 'keepa'].includes(normalized)) return false;
  return isSeriesDerivedPriceProvider(normalized);
}

function suspiciousStoredCurrentPriceReason(book) {
  const listPrice = trustedListPriceFor(book.currentPrice, book.listPrice, book.provider);
  return suspiciousPriceReason({
    price: book.currentPrice,
    points: book.currentPoints,
    effectivePrice: book.effectivePrice,
    listPrice,
    provider: book.provider,
    referencePrices: [
      listPrice,
      book.previousEffectivePrice,
      book.lowestPrice && Number(book.lowestPrice) !== Number(book.currentPrice) ? book.lowestPrice : null
    ]
  });
}

function isSuspiciousHistoryEntry(entry, book) {
  const provider = entry.provider || book.provider;
  const listPrice = trustedListPriceFor(entry.price, entry.listPrice ?? book.listPrice, provider);
  return Boolean(
    suspiciousPriceReason({
      price: entry.price,
      points: entry.points,
      effectivePrice: entry.effectivePrice,
      listPrice,
      provider,
      referencePrices: [book.currentPrice, book.effectivePrice, listPrice]
    })
  );
}

function isSuspiciousNotificationEntry(entry, book) {
  const listPrice = trustedListPriceFor(entry.effectivePrice, book.listPrice, book.provider);
  return Boolean(
    suspiciousPriceReason({
      price: entry.effectivePrice,
      points: 0,
      effectivePrice: entry.effectivePrice,
      listPrice,
      provider: book.provider,
      referencePrices: [book.currentPrice, book.effectivePrice, listPrice]
    })
  );
}

function hasSuspiciousStoredPriceFloor(book) {
  const lowestListPrice = trustedListPriceFor(book.lowestPrice, book.listPrice, book.provider);
  const lowestEffectiveListPrice = trustedListPriceFor(book.lowestEffectivePrice, book.listPrice, book.provider);
  return Boolean(
    suspiciousPriceReason({
      price: book.lowestPrice,
      points: 0,
      effectivePrice: book.lowestEffectivePrice,
      listPrice: lowestListPrice,
      provider: book.provider,
      referencePrices: [book.currentPrice, book.effectivePrice, lowestListPrice]
    }) ||
      suspiciousPriceReason({
        price: book.lowestEffectivePrice,
        points: 0,
        effectivePrice: book.lowestEffectivePrice,
        listPrice: lowestEffectiveListPrice,
        provider: book.provider,
        referencePrices: [book.currentPrice, book.effectivePrice, lowestEffectiveListPrice]
      })
  );
}

function clearUnreliableStoredListPrice(book) {
  if (!shouldIgnoreListPriceForProvider(book.currentPrice, book.listPrice, book.provider)) return false;
  book.listPrice = null;
  return true;
}

function trustedListPriceFor(currentPrice, listPrice, provider) {
  return shouldIgnoreListPriceForProvider(currentPrice, listPrice, provider) ? null : listPrice ?? null;
}

function shouldIgnoreListPriceForProvider(currentPrice, listPrice, provider) {
  if (!isSeriesDerivedPriceProvider(provider)) return false;
  const current = Number(currentPrice);
  const list = Number(listPrice);
  return Number.isFinite(current) && current > 0 && Number.isFinite(list) && list > 0 && current > list;
}

function isSeriesDerivedPriceProvider(provider) {
  const normalized = String(provider || '').toLowerCase();
  return normalized.includes('_series') || normalized === 'amazon_series_bulk' || normalized === 'amazon_series_reader';
}

function suspiciousPriceReason({ price, points = 0, effectivePrice = null, listPrice = null, provider = '', referencePrices = [] }) {
  const current = Number(price);
  if (!Number.isFinite(current) || current <= 0) return '';

  const pointValue = Number(points || 0);
  if (Number.isFinite(pointValue) && pointValue > current) return 'ポイントが価格を超えています';

  const list = Number(listPrice);
  if (Number.isFinite(list) && list > 0 && current > list * 1.15) return '価格が定価を大きく超えています';
  if (isLikelyPercentContaminatedStoredPrice({ price: current, points: pointValue, listPrice: list, provider })) {
    return '価格が割引率またはポイント率に見えます';
  }

  const reference = Math.max(
    ...referencePrices
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  );

  const effective = Number(effectivePrice);
  if (
    Number.isFinite(effective) &&
    effective === 0 &&
    Number.isFinite(reference) &&
    reference >= current * 2 &&
    pointValue > 0
  ) {
    return '実質価格が不自然に0円です';
  }

  return '';
}

function isLikelyPercentContaminatedStoredPrice({ price, points = 0, listPrice = null, provider = '' }) {
  if (String(provider || '').toLowerCase() !== 'amazon_html') return false;
  const current = Number(price);
  const pointValue = Number(points || 0);
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(pointValue) || pointValue <= 0) return false;

  const pointRatio = pointValue / current;
  if (current <= 10) return true;
  if (current <= 20 && pointRatio >= 0.3) return true;
  if (current <= 50 && pointRatio >= 0.5) return true;

  const list = Number(listPrice);
  return Number.isFinite(list) && list >= 1000 && current <= 100 && current <= list * 0.05 && pointRatio >= 0.2;
}

function recomputeBookPriceFloors(book, store) {
  const entries = store.priceHistory.filter(
    (entry) => entry.bookId === book.id && entry.price != null && !isUnvalidatedSeriesPriceHistoryEntry(entry)
  );
  const prices = entries.map((entry) => entry.price);
  const effectivePrices = entries.map((entry) => entry.effectivePrice).filter((value) => value != null);

  if (book.currentPrice != null) prices.push(book.currentPrice);
  if (book.effectivePrice != null) effectivePrices.push(book.effectivePrice);

  book.lowestPrice = prices.length ? Math.min(...prices) : book.currentPrice;
  book.lowestEffectivePrice = effectivePrices.length ? Math.min(...effectivePrices) : book.effectivePrice;
}

function seriesPriceProviderRank(provider) {
  const normalized = String(provider || '').toLowerCase();
  if (normalized === 'keepa' || normalized === 'amazon_html') return 100;
  if (normalized === 'amazon_reader') return 90;
  if (normalized === 'listasin') return 85;
  if (normalized === 'amazon_series_bulk') return 95;
  if (normalized === 'amazon_series_unit_price' || normalized === 'amazon_series_source_price') return 0;
  if (normalized === 'amazon_series_reader') return 70;
  if (normalized === 'efox') return 82;
  if (normalized === 'efox_series') return 79;
  if (normalized === 'sale_bon_series') return 80;
  if (normalized === 'kintyaku') return 79;
  if (normalized === 'kintyaku_series') return 76;
  if (normalized === 'kinpome') return 78;
  if (normalized === 'kinpome_series') return 75;
  if (normalized === 'external_series') return 50;
  if (normalized === 'existing_series') return 40;
  if (normalized === 'curated_series') return 10;
  if (normalized === 'pending' || normalized === 'pending_series' || normalized === 'series_diff_pending') return 0;
  return 30;
}

function isRefreshableSeriesPriceProvider(provider) {
  return [
    'amazon_html',
    'amazon_reader',
    'listasin',
    'amazon_series_reader',
    'amazon_series_bulk',
    'sale_bon_series',
    'efox',
    'efox_series',
    'kintyaku',
    'kintyaku_series',
    'kinpome',
    'kinpome_series',
    'external_series'
  ].includes(String(provider || '').toLowerCase());
}

function seriesImageProviderRank(provider) {
  const normalized = String(provider || '').toLowerCase();
  if (normalized === 'keepa' || normalized === 'amazon_html') return 100;
  if (normalized === 'amazon_reader') return 90;
  if (normalized === 'listasin') return 90;
  if (normalized === 'amazon_series_reader') return 85;
  if (normalized === 'efox' || normalized === 'efox_series') return 82;
  if (normalized === 'external_series') return 80;
  if (normalized === 'kintyaku' || normalized === 'kintyaku_series') return 78;
  if (normalized === 'amazon_series_bulk') return 60;
  if (normalized === 'sale_bon_series') return 40;
  if (normalized === 'existing_series') return 30;
  if (normalized === 'curated_series') return 10;
  if (normalized === 'pending' || normalized === 'pending_series' || normalized === 'series_diff_pending') return 0;
  return 20;
}

function mergeWithKnownSeriesItems(items, books, options) {
  const merged = new Map();
  for (const item of items) {
    if (item.asin) merged.set(item.asin, item);
  }
  const currentSeriesAsins = new Set(merged.keys());

  for (const book of books) {
    if (!isKnownBookForSeries(book, options) || merged.has(book.asin)) continue;
    if (isLikelyObsoleteSingleEpisodeSeriesBook(book, currentSeriesAsins, options.seriesName)) continue;
    merged.set(book.asin, seedFromExistingBook(book));
  }

  return [...merged.values()].sort(compareSeriesItemSeeds);
}

function removeStoreBooksById(store, ids) {
  if (!ids?.size) return;
  store.books = store.books.filter((book) => !ids.has(book.id));
  store.priceHistory = store.priceHistory.filter((entry) => !ids.has(entry.bookId));
  store.notifications = store.notifications.filter((entry) => !ids.has(entry.bookId));
  compactSeriesPriceHistory(store);
  resetCursorIfDeleted(store, ids);
}

function isLikelyObsoleteSingleEpisodeSeriesBook(book, currentSeriesAsins, seriesName = '') {
  if (!book?.asin || currentSeriesAsins.has(book.asin)) return false;
  if (isClearlyDifferentSeriesTitle(book.title, seriesName || book.seriesName)) return true;
  if (isSingleEpisodeLikeTitle(book.title)) return true;
  return isCheapAmazonBulkSeriesBook(book);
}

function isSingleEpisodeLikeTitle(title) {
  const value = String(title || '');
  return /単話|分冊|全\s*[0-9０-９]{1,4}\s*話中第\s*[0-9０-９]{1,4}\s*話|第\s*[0-9０-９]{1,4}\s*話/u.test(value);
}

function isCheapAmazonBulkSeriesBook(book) {
  const provider = String(book?.provider || '').toLowerCase();
  const price = Number(book?.currentPrice);
  return (
    provider === 'amazon_series_bulk' &&
    Number.isFinite(price) &&
    price > 0 &&
    price <= SINGLE_EPISODE_SERIES_PRICE_MAX
  );
}

function isClearlyDifferentSeriesTitle(title, seriesName) {
  const rawTitle = String(title || '').trim();
  const rawSeriesName = String(seriesName || '').trim();
  if (!rawTitle || isGenericSeriesName(rawSeriesName)) return false;
  if (/^ASIN\s+[A-Z0-9]{10}$/i.test(rawTitle) || isAmazonErrorPageBookTitle(rawTitle)) return false;

  const titleStem = seriesTitleComparisonStem(rawTitle);
  const seriesStem = seriesTitleComparisonStem(rawSeriesName);
  if (!titleStem || !seriesStem || seriesStem.length < 3) return false;
  if (titleStem.includes(seriesStem) || seriesStem.includes(titleStem)) return false;

  const titleCore = seriesTitleComparisonCore(rawTitle);
  const seriesCore = seriesTitleComparisonCore(rawSeriesName);
  if (!titleCore || !seriesCore || titleCore.length < 3 || seriesCore.length < 3) return false;
  if (titleCore.includes(seriesCore) || seriesCore.includes(titleCore)) return false;
  if (commonPrefixLength(titleCore, seriesCore) >= Math.min(6, titleCore.length, seriesCore.length)) return false;

  return true;
}

function isGenericSeriesName(seriesName) {
  const normalized = normalizeSeriesNameForComparison(seriesName);
  return (
    !normalized ||
    normalized === 'kindleシリーズ' ||
    normalized === 'kindleseries' ||
    normalized === 'シリーズ'
  );
}

function seriesTitleComparisonCore(value) {
  return seriesTitleComparisonStem(stripSupplementalTitleSegments(value));
}

function seriesTitleComparisonStem(value) {
  return stripSeriesVolumeMarkers(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function stripSupplementalTitleSegments(value) {
  return String(value || '')
    .replace(/[（(［\[][^）)\]］]*(?:comic|comics|コミック|コミックス|kindle|digital|電子|harta|itan|feel|onblue)[^）)\]］]*[）)\]］]/giu, ' ')
    .replace(/[【][^】]*(?:comic|comics|コミック|コミックス|kindle|digital|電子)[^】]*[】]/giu, ' ');
}

function stripSeriesVolumeMarkers(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/(?:第)?[0-9]{1,4}\s*巻/giu, ' ')
    .replace(/[ (（]*[0-9]{1,4}[ )）]*$/u, ' ')
    .replace(/[ 　]*(?:上|中|下|前編|後編|完結編)\s*$/u, ' ');
}

function commonPrefixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index;
}

function isKnownBookForSeries(book, options) {
  if (!book?.asin) return false;
  if (book.seriesKey && book.seriesKey === options.seriesKey) return true;
  if (isSameSeriesSource(book.sourceUrl, options.sourceUrl, options.sourceAsin)) return true;
  return Boolean(
    options.seriesName &&
      options.seriesName !== 'Kindle シリーズ' &&
      book.seriesName &&
      book.seriesName === options.seriesName
  );
}

function seedFromExistingBook(book) {
  return {
    asin: book.asin,
    title: book.title,
    imageUrl: book.imageUrl || '',
    imageSource: book.imageSource || '',
    amazonUrl: book.amazonUrl || amazonUrlForAsin(book.asin),
    seriesName: book.seriesName || '',
    volume: book.volume || '',
    seriesExpectedCount: book.seriesExpectedCount || '',
    currentPrice: book.currentPrice ?? null,
    currentPoints: book.currentPoints ?? 0,
    effectivePrice: book.effectivePrice ?? effectivePriceFromSeed(book),
    listPrice: book.listPrice ?? null,
    provider: book.provider || 'existing_series',
    lastError: book.lastError || ''
  };
}

function compareSeriesItemSeeds(a, b) {
  const av = seriesItemVolume(a) || 9999;
  const bv = seriesItemVolume(b) || 9999;
  if (av !== bv) return av - bv;
  return String(a.title || a.asin).localeCompare(String(b.title || b.asin), 'ja');
}

function seriesItemVolume(item) {
  return volumeFromSeriesTitle(item?.title) || Number(item?.volume) || 0;
}

function volumeFromSeriesTitle(title) {
  const value = String(title || '');
  const match =
    value.match(/(?:第)?([0-9０-９]{1,3})\s*巻/) ||
    value.match(/[　\s（(]([0-9０-９]{1,3})[）)]?\s*$/);
  if (!match) return 0;
  return Number(String(match[1]).replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10)));
}

function normalizeSeriesExpectedCount(series, items) {
  return Math.max(
    Number(series?.expectedVolumeCount) || 0,
    maxSeriesItemVolume(items),
    items.length
  );
}

function maxSeriesItemVolume(items) {
  const volumes = items.map(seriesItemVolume).filter((value) => Number.isFinite(value) && value > 0);
  return volumes.length ? Math.max(...volumes) : 0;
}

export async function deleteBook(id) {
  return deleteBooks([id]);
}

export async function deleteBooks(ids) {
  const targetIds = new Set(Array.isArray(ids) ? ids.filter(Boolean) : []);
  if (targetIds.size === 0) return { deleted: 0 };

  let deleted = 0;
  await updateStore((store) => {
    deleted = store.books.filter((book) => targetIds.has(book.id)).length;
    store.books = store.books.filter((book) => !targetIds.has(book.id));
    store.priceHistory = store.priceHistory.filter((entry) => !targetIds.has(entry.bookId));
    store.notifications = store.notifications.filter((entry) => !targetIds.has(entry.bookId));
    compactSeriesPriceHistory(store);
    resetCursorIfDeleted(store, targetIds);
    return store;
  });

  return { deleted };
}

export async function deleteAllBooks() {
  let deleted = 0;
  await updateStore((store) => {
    deleted = store.books.length;
    store.books = [];
    store.priceHistory = [];
    store.seriesPriceHistory = [];
    store.notifications = [];
    store.checkCursor = emptyCheckCursor();
    return store;
  });

  return { deleted };
}

export async function deleteSeries(seriesKey, sourceUrl = '') {
  await updateStore((store) => {
    const targetIds = new Set(
      store.books
        .filter((book) => {
          if (seriesKey && book.seriesKey === seriesKey) return true;
          if (sourceUrl && book.sourceUrl === sourceUrl) return true;
          return false;
        })
        .map((book) => book.id)
    );

    store.books = store.books.filter((book) => !targetIds.has(book.id));
    store.priceHistory = store.priceHistory.filter((entry) => !targetIds.has(entry.bookId));
    store.seriesPriceHistory = store.seriesPriceHistory.filter((entry) => {
      if (seriesKey && (entry.seriesKey === seriesKey || entry.key === seriesKey)) return false;
      if (sourceUrl && entry.sourceUrl === sourceUrl) return false;
      return true;
    });
    store.notifications = store.notifications.filter((entry) => {
      if (targetIds.has(entry.bookId)) return false;
      if (seriesKey && (entry.seriesKey === seriesKey || entry.notificationKey === seriesKey)) return false;
      if (sourceUrl && entry.notificationKey === `series:url:${sourceUrl}`) return false;
      return true;
    });
    compactSeriesPriceHistory(store);
    resetCursorIfDeleted(store, targetIds);
    return store;
  });
}

export async function getHistory(bookId) {
  const store = await readStoreWithPriceRepairs();
  return store.priceHistory
    .filter((entry) => entry.bookId === bookId)
    .sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt));
}

export async function checkBookById(id, options = {}) {
  const store = await readStoreWithPriceRepairs();
  const book = store.books.find((item) => item.id === id);
  if (!book) {
    const error = new Error('本が見つかりません');
    error.status = 404;
    throw error;
  }
  return checkOneBook(book, options);
}

export async function repairBookPricesByAsins(asins, options = {}) {
  const requestedAsins = [
    ...new Set(
      (Array.isArray(asins) ? asins : [])
        .map((asin) => String(asin || '').trim().toUpperCase())
        .filter(isProbablyBookAsin)
    )
  ];
  if (requestedAsins.length === 0) {
    const error = new Error('修復対象のASINを指定してください');
    error.status = 400;
    throw error;
  }
  if (requestedAsins.length > 30) {
    const error = new Error('一度に修復できるASINは30件までです');
    error.status = 400;
    throw error;
  }

  const now = options.now || new Date().toISOString();
  const currentStore = await readStore();
  const booksByAsin = new Map((currentStore.books || []).map((book) => [book.asin, book]));
  const snapshotTargets = [];
  const missing = [];

  for (const asin of requestedAsins) {
    const book = booksByAsin.get(asin);
    if (!book) {
      missing.push(asin);
      continue;
    }
    snapshotTargets.push({
      asin,
      bookId: book.id,
      book
    });
  }

  const snapshotResults = await mapWithConcurrency(
    snapshotTargets,
    repairPriceFetchConcurrency(options),
    async (target) => ({
      asin: target.asin,
      bookId: target.bookId,
      snapshotResult: await settleSnapshotWithDeadline(
        target.asin,
        target.book,
        repairPriceSnapshotTimeoutMs(options)
      )
    })
  );

  const summary = {
    mode: 'price_repair',
    total: requestedAsins.length,
    processed: 0,
    repaired: 0,
    failed: 0,
    missing,
    results: []
  };

  await updateStore((store) => {
    for (const entry of snapshotResults) {
      const bookBefore = store.books.find((book) => book.id === entry.bookId);
      const before = bookBefore ? priceStateForComparison(bookBefore) : null;
      const applied = applyCheckResultToStore(
        store,
        { id: entry.bookId, asin: entry.asin },
        entry.snapshotResult,
        now,
        {
          updateCursor: false,
          recordNotifications: false
        }
      );
      const bookAfter = applied.checkedBook;
      const after = bookAfter ? priceStateForComparison(bookAfter) : null;
      const changed = JSON.stringify(before) !== JSON.stringify(after);

      summary.processed += 1;
      if (entry.snapshotResult.ok) {
        if (changed) summary.repaired += 1;
      } else {
        summary.failed += 1;
      }
      summary.results.push({
        asin: entry.asin,
        ok: Boolean(entry.snapshotResult.ok),
        changed,
        error: entry.snapshotResult.ok ? '' : entry.snapshotResult.error || '',
        book: bookAfter ? publicBook(bookAfter) : null
      });
    }
    return store;
  });

  return summary;
}

async function settleSnapshotWithDeadline(asin, book, timeoutMs) {
  if (!timeoutMs) return settleSnapshot(asin, book);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await settleSnapshot(asin, book, {
      signal: controller.signal,
      timeoutMs
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function repairPriceSnapshotTimeoutMs(options = {}) {
  return floorNumber(options.timeoutMs ?? process.env.REPAIR_PRICE_SNAPSHOT_TIMEOUT_MS, 1000, 25000);
}

function repairPriceFetchConcurrency(options = {}) {
  return clampNumber(options.concurrency ?? process.env.REPAIR_PRICE_CONCURRENCY, 1, 5, 3);
}

async function mapWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runDueChecks(options = {}) {
  const source = options.source || 'manual';
  const cronStartedAt = new Date().toISOString();

  try {
    const startedAt = Date.now();
    const maxRuntimeMs = floorNumber(process.env.CHECK_MAX_RUNTIME_MS, 0, 0);
    const saveReserveMs = runtimeSaveReserveMs();
    let store = await readStoreWithPriceRepairs();
    let settings = mergedRuntimeSettings(store.settings);
    const forceAll = options.force === true || readEnvBoolean('FORCE_CHECK_ALL', false);
    const isBackupRun = source === 'cron' && options.backup === true;

    if (!forceAll && shouldWaitForScheduledExecutionWindow(source, options, startedAt, settings)) {
      const remainingDue = countDueBooks(store.books, startedAt, settings);
      const nextRunAtMs = nextJstExecutionBoundaryMs(startedAt, settings);
      const result = {
        checked: 0,
        remainingDue,
        cursor: store.checkCursor,
        overlapped: 0,
        stoppedByRuntimeLimit: false,
        forced: false,
        skipped: true,
        skipReason: 'scheduled_time',
        nextRunAt: new Date(nextRunAtMs).toISOString(),
        seriesDiscovery: null,
        results: []
      };

      return result;
    }

    if (!forceAll && isBackupRun) {
      const backupSkip = backupCronSkipState(store.automation, startedAt, settings);
      if (backupSkip.shouldSkip) {
        return {
          checked: 0,
          remainingDue: countDueBooks(store.books, startedAt, settings),
          cursor: store.checkCursor,
          overlapped: 0,
          stoppedByRuntimeLimit: false,
          forced: false,
          backup: true,
          skipped: true,
          skipReason: 'primary_cron_completed',
          skipDetail: backupSkip.skipDetail,
          executionBoundaryAt: backupSkip.executionBoundaryAt,
          lastCronStartedAt: backupSkip.lastCronStartedAt,
          lastCronFinishedAt: backupSkip.lastCronFinishedAt,
          lastCronStoppedByRuntimeLimit: backupSkip.lastCronStoppedByRuntimeLimit,
          lastCronError: backupSkip.lastCronError,
          seriesDiscovery: null,
          results: []
        };
      }
    }

    const importQueue = shouldRunBookImportQueue(source, options)
      ? await processBookImportQueueInStore(store, { startedAt, maxRuntimeMs, saveReserveMs, now: cronStartedAt })
      : null;
    const seriesDiscovery = shouldRunSeriesDiscovery(source, options, store, settings, startedAt)
      ? await discoverSeriesUpdates(store, { startedAt, maxRuntimeMs, saveReserveMs })
      : null;
    settings = mergedRuntimeSettings(store.settings);
    const plan = planDueChecks(store, settings, startedAt, { forceAll });
    const pacing = checkPacing();
    const getWebhookUrls = options.notify === false ? null : sharedWebhookUrlLoader();
    const seriesNotificationBaselines = new Map();
    const seriesFreshAfter = seriesAggregateFreshAfter(startedAt, settings).toISOString();

    const results = [];
    let stoppedByRuntimeLimit = false;
    const processedBookIds = new Set();
    for (let index = 0; index < plan.books.length; index += 1) {
      if (shouldStopForRuntimeLimit(startedAt, maxRuntimeMs, results.length, saveReserveMs)) {
        stoppedByRuntimeLimit = true;
        break;
      }

      if (!(await waitBeforeCheck(pacing, results.length, startedAt, maxRuntimeMs, saveReserveMs))) {
        stoppedByRuntimeLimit = true;
        break;
      }

      const book = plan.books[index];
      const runtime = runtimeAbortOptions(startedAt, maxRuntimeMs, {
        reserveMs: saveReserveMs,
        capMs: checkBookMaxRuntimeMs()
      });
      let result;
      try {
        result = await checkOneBookInStore(store, book, {
          ...options,
          signal: runtime.signal,
          updateCursor: true,
          getWebhookUrls,
          deferSeriesNotifications: true,
          seriesNotificationBaselines,
          seriesFreshAfter
        });
      } finally {
        runtime.cleanup();
      }
      results.push(result);
      processedBookIds.add(book.id);

      if (isBlockingCheckResult(result)) {
        if (!(await waitAfterBlockedCheck(pacing, startedAt, maxRuntimeMs, saveReserveMs))) {
          stoppedByRuntimeLimit = true;
          break;
        }
      }

      if (shouldStopForRuntimeLimit(startedAt, maxRuntimeMs, results.length, saveReserveMs)) {
        stoppedByRuntimeLimit = true;
        break;
      }
    }

    const seriesNotifications = await sendDeferredSeriesNotifications(store, seriesNotificationBaselines, {
      ...options,
      getWebhookUrls
    });
    const remainingDue = countDueBooks(store.books, Date.now(), settings);
    const finishedAt = new Date().toISOString();
    const result = {
      checked: results.length,
      remainingDue,
      cursor: store.checkCursor,
      overlapped: Math.max(0, results.length - plan.dueSelected),
      stoppedByRuntimeLimit,
      forced: forceAll,
      backup: isBackupRun,
      importQueue,
      seriesDiscovery,
      seriesNotifications,
      results
    };

    const cronFields = source === 'cron' && shouldPersistCronRun(result)
      ? {
          lastCronStartedAt: cronStartedAt,
          lastCronFinishedAt: finishedAt,
          lastCronChecked: result.checked,
          lastCronRemainingDue: result.remainingDue,
          lastCronStoppedByRuntimeLimit: result.stoppedByRuntimeLimit,
          lastImportQueueProcessed: importQueue?.processed || 0,
          lastImportQueueImported: importQueue?.imported || 0,
          lastImportQueueErrors: importQueue?.errors?.length || 0,
          lastSeriesDiscoveryChecked: seriesDiscovery?.checked || 0,
          lastSeriesDiscoveryAdded: seriesDiscovery?.added || 0,
          lastSeriesDiscoveryCompleted: seriesDiscovery?.completed || 0,
          lastSeriesDiscoverySkipped: seriesDiscovery?.skippedNoRun || 0,
          lastSeriesDiscoveryErrors: seriesDiscovery?.errors?.length || 0,
          lastCronError: ''
        }
      : null;

    if (processedBookIds.size > 0 || cronFields || hasSeriesDiscoveryWork(seriesDiscovery) || hasImportQueueWork(importQueue)) {
      await persistBulkCheckStore({
        store,
        cronFields
      });
    }

    result.summaryNotification = await sendCronSummaryNotification(result, {
      source,
      options,
      startedAt: cronStartedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - startedAt,
      getWebhookUrls
    });

    if (source === 'cron') {
      result.cronPersisted = Boolean(cronFields);
    }

    return result;
  } catch (error) {
    if (source === 'cron') {
      await recordCronRun({
        lastCronStartedAt: cronStartedAt,
        lastCronFinishedAt: new Date().toISOString(),
        lastCronError: error.message || String(error)
      });
    }
    throw error;
  }
}

async function discoverSeriesUpdates(store, options = {}) {
  const now = new Date().toISOString();
  const plan = planSeriesDiscovery(store, { now });
  const pacing = seriesDiscoveryPacing();
  const saveReserveMs = Number(options.saveReserveMs || 0);
  const results = [];
  const errors = [];
  let added = 0;
  let completed = 0;
  let stoppedByRuntimeLimit = false;

  for (const group of plan.groups) {
    if (
      shouldStopSeriesDiscoveryForRuntimeLimit(
        options.startedAt,
        options.maxRuntimeMs,
        results.length + errors.length,
        saveReserveMs
      )
    ) {
      stoppedByRuntimeLimit = true;
      break;
    }

    try {
      if (
        !(await waitBeforeSeriesDiscovery(
          pacing,
          results.length + errors.length,
          options.startedAt,
          options.maxRuntimeMs,
          saveReserveMs
        ))
      ) {
        stoppedByRuntimeLimit = true;
        break;
      }

      const runtime = runtimeAbortOptions(options.startedAt, options.maxRuntimeMs, {
        reserveMs: saveReserveMs,
        capMs: importItemMaxRuntimeMs()
      });
      let result;
      try {
        result = await addSeriesBooksFromInputInStore(store, seriesDiscoveryInput(group.sourceUrl, group.seriesKey), {
          now,
          signal: runtime.signal
        });
      } finally {
        runtime.cleanup();
      }
      const newBooks = Number(result.imported || 0);
      const seriesCompleted = Boolean(result.seriesCompleted);
      added += newBooks;
      if (seriesCompleted) completed += 1;
      results.push({
        seriesKey: group.seriesKey,
        seriesName: group.seriesName,
        checked: true,
        added: newBooks,
        completed: seriesCompleted
      });
      recordSeriesDiscoveryCursorInStore(store, group, now);
    } catch (error) {
      const message = error.message || String(error);
      errors.push({
        seriesKey: group.seriesKey,
        seriesName: group.seriesName,
        error: message
      });
      markSeriesDiscoveryErrorInStore(store, group, now, message);
      recordSeriesDiscoveryCursorInStore(store, group, now);
    }

    if (
      shouldStopSeriesDiscoveryForRuntimeLimit(
        options.startedAt,
        options.maxRuntimeMs,
        results.length + errors.length,
        saveReserveMs
      )
    ) {
      stoppedByRuntimeLimit = true;
      break;
    }
  }

  return {
    checked: results.length + errors.length,
    added,
    completed,
    skippedNoRun: plan.skippedNoRun,
    skippedCompleted: plan.skippedCompleted,
    markedNoRun: plan.markedNoRun,
    stoppedByRuntimeLimit,
    cursor: store.seriesDiscoveryCursor,
    results,
    errors
  };
}

function shouldRunSeriesDiscovery(source, options = {}, store = {}, settings = {}, now = Date.now()) {
  if (options.discoverSeries === true) return true;
  if (options.discoverSeries === false) return false;
  if (source !== 'cron' && source !== 'scheduler') return false;

  const intervalHours = floorNumber(process.env.SERIES_DISCOVERY_INTERVAL_HOURS, 1, 24);
  const intervalDays = Math.max(1, Math.round(intervalHours / 24));
  const lastCheckedAt = new Date(store.seriesDiscoveryCursor?.checkedAt || 0).getTime();
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) return true;

  const boundary = latestJstExecutionBoundaryMs(now, settings);
  const lastBoundary = latestJstExecutionBoundaryMs(lastCheckedAt, settings);
  return boundary - lastBoundary >= intervalDays * 24 * 60 * 60 * 1000;
}

function shouldRunBookImportQueue(source, options = {}) {
  if (options.importQueue === true) return true;
  if (options.importQueue === false) return false;
  return source === 'cron' || source === 'scheduler';
}

async function processBookImportQueueInStore(store, options = {}) {
  const now = options.now || new Date().toISOString();
  const inputs = await loadBookImportQueueInputs(store);
  const pending = new Map((store.importQueue?.pending || []).map((entry) => [entry.key, entry]));
  const completed = new Map((store.importQueue?.completed || []).map((entry) => [entry.key, entry]));
  const existingErrors = new Map((store.importQueue?.errors || []).map((entry) => [entry.key, entry]));
  const saveReserveMs = Number(options.saveReserveMs || 0);
  const results = [];
  const errors = [];
  let imported = 0;
  let skippedDuplicates = 0;
  let updatedDuplicates = 0;
  let skippedCompleted = 0;
  let stoppedByRuntimeLimit = false;

  store.importQueue = store.importQueue || { pending: [], completed: [], errors: [] };

  for (const input of inputs) {
    if (shouldStopForRuntimeLimit(options.startedAt, options.maxRuntimeMs, results.length + errors.length, saveReserveMs)) {
      stoppedByRuntimeLimit = true;
      break;
    }

    const key = bookImportQueueKey(input);
    if (completed.has(key)) {
      pending.delete(key);
      skippedCompleted += 1;
      continue;
    }

    try {
      const runtime = runtimeAbortOptions(options.startedAt, options.maxRuntimeMs, {
        reserveMs: saveReserveMs,
        capMs: importItemMaxRuntimeMs()
      });
      let result;
      try {
        result = await addBooksFromInputInStore(store, input, { now, signal: runtime.signal });
      } finally {
        runtime.cleanup();
      }
      const entry = {
        key,
        input,
        importedAt: now,
        mode: result.mode || '',
        imported: Number(result.imported || 0),
        skippedDuplicates: Number(result.skippedDuplicates || 0),
        updatedDuplicates: Number(result.updatedDuplicates || 0)
      };
      completed.set(key, entry);
      pending.delete(key);
      existingErrors.delete(key);
      imported += entry.imported;
      skippedDuplicates += entry.skippedDuplicates;
      updatedDuplicates += entry.updatedDuplicates;
      results.push(entry);
    } catch (error) {
      const entry = {
        key,
        input,
        checkedAt: now,
        error: error.message || String(error)
      };
      existingErrors.set(key, entry);
      errors.push(entry);
    }

    if (shouldStopForRuntimeLimit(options.startedAt, options.maxRuntimeMs, results.length + errors.length, saveReserveMs)) {
      stoppedByRuntimeLimit = true;
      break;
    }
  }

  store.importQueue.pending = [...pending.values()];
  store.importQueue.completed = [...completed.values()].slice(-200);
  store.importQueue.errors = [...existingErrors.values()].slice(-100);

  return {
    total: inputs.length,
    processed: results.length + errors.length,
    imported,
    skippedDuplicates,
    updatedDuplicates,
    skippedCompleted,
    stoppedByRuntimeLimit,
    results,
    errors
  };
}

async function loadBookImportQueueInputs(store = null) {
  const inputs = new Map();
  for (const entry of store?.importQueue?.pending || []) {
    if (entry?.input) inputs.set(bookImportQueueKey(entry.input), entry.input);
  }

  for (const input of parseBookImportInputs(process.env.BOOK_IMPORT_INPUTS || '')) {
    inputs.set(bookImportQueueKey(input), input);
  }

  const queuePath = String(process.env.BOOK_IMPORT_QUEUE_PATH || 'data/import-queue.txt').trim();
  if (queuePath && queuePath.toLowerCase() !== 'false') {
    try {
      const raw = await fs.readFile(path.resolve(process.cwd(), queuePath), 'utf8');
      for (const input of parseBookImportInputs(raw)) {
        inputs.set(bookImportQueueKey(input), input);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return [...inputs.values()];
}

function parseBookImportInputs(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(normalizeBookImportInput).filter(Boolean);
    } catch {
      // Fall through to line-based parsing.
    }
  }

  return text
    .split(/\r?\n/)
    .map(normalizeBookImportInput)
    .filter((line) => line && !line.startsWith('#'));
}

function normalizeBookImportInput(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

function bookImportQueueKey(input) {
  const asin = extractAsin(input);
  if (asin) return `asin:${asin.toUpperCase()}`;
  return `input:${String(input || '').trim()}`;
}

function planSeriesDiscovery(store, options = {}) {
  const allGroups = seriesDiscoveryGroups(store.books);
  const completedGroups = allGroups.filter((group) => group.completed);
  const markedNoRun = markNoRunSeriesDiscoveryGroups(store, completedGroups, {
    now: options.now,
    reason: 'completed'
  });
  const groups = rotateSeriesGroupsAfterCursor(
    allGroups.filter((group) => !group.completed),
    store.seriesDiscoveryCursor?.lastSeriesKey
  );
  const limit = floorNumber(process.env.SERIES_DISCOVERY_BATCH_SIZE, 1, 50);
  return {
    groups: groups.slice(0, limit),
    totalEligible: groups.length,
    skippedCompleted: completedGroups.length,
    skippedNoRun: completedGroups.length,
    markedNoRun
  };
}

function seriesDiscoveryGroups(books = []) {
  const groups = new Map();
  const aliasToGroupKey = new Map();

  for (const book of books) {
    if (book.importMode !== 'kindle_series' && !book.seriesKey) continue;
    const bookSeriesKey = book.seriesKey || '';
    const sourceUrl = book.sourceUrl || seriesInputFromSeriesKey(bookSeriesKey);
    const fallbackKey = bookSeriesKey || sourceUrl;
    if (!fallbackKey || !sourceUrl) continue;

    const aliases = [bookSeriesKey, sourceUrl].filter(Boolean);
    const groupKey = aliases.map((alias) => aliasToGroupKey.get(alias)).find(Boolean) || fallbackKey;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        seriesKey: bookSeriesKey || fallbackKey,
        sourceUrl,
        seriesName: book.seriesName || seriesTitleFromBook(book),
        completed: false,
        books: []
      });
    }
    for (const alias of aliases) {
      aliasToGroupKey.set(alias, groupKey);
    }

    const group = groups.get(groupKey);
    if (bookSeriesKey && (!group.seriesKey || group.seriesKey === group.sourceUrl)) group.seriesKey = bookSeriesKey;
    if (!group.sourceUrl && sourceUrl) group.sourceUrl = sourceUrl;
    group.books.push(book);
    group.completed = group.completed || Boolean(book.seriesCompleted);
  }

  return [...groups.values()];
}

function markNoRunSeriesDiscoveryGroups(store, groups, options = {}) {
  const now = options.now || new Date().toISOString();
  const reason = options.reason || 'not_applicable';
  if (groups.length === 0) return 0;

  let changedGroups = 0;
  for (const group of groups) {
    let groupChanged = false;
    for (const book of store.books || []) {
      if (!bookBelongsToSeriesDiscoveryGroup(book, group)) continue;
      let bookChanged = false;
      if (book.seriesDiscoveryStatus !== 'skipped') {
        book.seriesDiscoveryStatus = 'skipped';
        bookChanged = true;
      }
      if (book.seriesDiscoverySkipReason !== reason) {
        book.seriesDiscoverySkipReason = reason;
        bookChanged = true;
      }
      if (!book.seriesDiscoverySkippedAt) {
        book.seriesDiscoverySkippedAt = now;
        bookChanged = true;
      }
      if (book.seriesDiscoveryError) {
        book.seriesDiscoveryError = '';
        bookChanged = true;
      }
      if (bookChanged) {
        book.updatedAt = now;
        groupChanged = true;
      }
    }
    if (groupChanged) changedGroups += 1;
  }

  return changedGroups;
}

function bookBelongsToSeriesDiscoveryGroup(book, group) {
  const bookSeriesKey = book.seriesKey || book.sourceUrl || '';
  if (bookSeriesKey && bookSeriesKey === group.seriesKey) return true;
  if (book.sourceUrl && book.sourceUrl === group.sourceUrl) return true;
  return false;
}

function rotateSeriesGroupsAfterCursor(groups, lastSeriesKey = '') {
  if (!Array.isArray(groups) || groups.length === 0) return [];
  const cursorIndex = groups.findIndex((group) => group.seriesKey === lastSeriesKey);
  if (cursorIndex === -1 || cursorIndex === groups.length - 1) return [...groups];
  return [...groups.slice(cursorIndex + 1), ...groups.slice(0, cursorIndex + 1)];
}

function seriesInputFromSeriesKey(seriesKey = '') {
  const match = String(seriesKey).match(/^series:asin:([A-Z0-9]{10})$/i);
  return match ? kindleSeriesUrlForAsin(match[1].toUpperCase()) : '';
}

function seriesDiscoveryInput(sourceUrl = '', seriesKey = '') {
  const asin = extractAsin(sourceUrl) || String(seriesKey || '').match(/^series:asin:([A-Z0-9]{10})$/i)?.[1];
  return asin ? kindleSeriesUrlForAsin(asin.toUpperCase()) : sourceUrl;
}

function seriesTitleFromBook(book) {
  return String(book.seriesName || book.title || 'Kindle シリーズ')
    .replace(/\s*\(?\d+\)?\s*巻?.*$/, '')
    .trim();
}

function shouldStopSeriesDiscoveryForRuntimeLimit(startedAt, maxRuntimeMs, completedCount, reserveMs = 0) {
  return shouldStopForRuntimeLimit(startedAt, maxRuntimeMs, completedCount, reserveMs);
}

function markSeriesDiscoveryErrorInStore(store, group, now, error) {
  for (const book of store.books) {
    if (book.seriesKey !== group.seriesKey) continue;
    applySeriesDiscoveryMetadata(book, { now, error });
  }
}

function recordSeriesDiscoveryCursorInStore(store, group, now) {
  store.seriesDiscoveryCursor = {
    lastSeriesKey: group.seriesKey,
    checkedAt: now
  };
}

export async function getSettings() {
  const store = await readStore();
  return mergedRuntimeSettings(store.settings);
}

export async function getAutomationStatus() {
  const store = await readStore();
  return store.automation || {};
}

export async function getSettingsSummary() {
  const [store, webhooks] = await Promise.all([readStore(), getDiscordWebhooks()]);
  return {
    settings: mergedRuntimeSettings(store.settings),
    automation: store.automation || {},
    importQueue: publicBookImportQueue(store.importQueue),
    discordConfigured: webhooks.count > 0,
    discordWebhookCount: webhooks.count,
    discordWebhookTotalCount: webhooks.totalCount,
    discordWebhookPausedCount: webhooks.pausedCount
  };
}

export async function getBookImportQueue() {
  const store = await readStore();
  return publicBookImportQueue(store.importQueue);
}

export async function saveBookImportQueue(inputs) {
  const parsedInputs = Array.isArray(inputs)
    ? inputs.map(normalizeBookImportInput).filter(Boolean)
    : parseBookImportInputs(inputs);
  const deduped = [...new Map(parsedInputs.map((input) => [bookImportQueueKey(input), input])).values()];
  const now = new Date().toISOString();
  let result;

  await updateStore((store) => {
    store.importQueue = store.importQueue || { pending: [], completed: [], errors: [] };
    const previousPending = new Map((store.importQueue.pending || []).map((entry) => [entry.key, entry]));
    store.importQueue.pending = deduped.map((input) => {
      const key = bookImportQueueKey(input);
      const previous = previousPending.get(key);
      return {
        key,
        input,
        addedAt: previous?.addedAt || now
      };
    });
    result = publicBookImportQueue(store.importQueue);
    return store;
  });

  return result;
}

export async function enqueueBookImportQueue(inputs) {
  const parsedInputs = Array.isArray(inputs)
    ? inputs.map(normalizeBookImportInput).filter(Boolean)
    : parseBookImportInputs(inputs);
  const deduped = [...new Map(parsedInputs.map((input) => [bookImportQueueKey(input), input])).values()];
  if (deduped.length === 0) {
    const error = new Error('Amazon Kindle URL または ASIN を入力してください');
    error.status = 400;
    throw error;
  }

  const now = new Date().toISOString();
  let result;
  let added = 0;

  await updateStore((store) => {
    store.importQueue = store.importQueue || { pending: [], completed: [], errors: [] };
    const pending = new Map((store.importQueue.pending || []).map((entry) => [entry.key, entry]));
    const completed = new Map((store.importQueue.completed || []).map((entry) => [entry.key, entry]));
    const errors = new Map((store.importQueue.errors || []).map((entry) => [entry.key, entry]));

    for (const input of deduped) {
      const key = bookImportQueueKey(input);
      const previous = pending.get(key);
      if (!previous) added += 1;
      pending.set(key, {
        key,
        input,
        addedAt: previous?.addedAt || now
      });
      completed.delete(key);
      errors.delete(key);
    }

    store.importQueue.pending = [...pending.values()];
    store.importQueue.completed = [...completed.values()].slice(-200);
    store.importQueue.errors = [...errors.values()].slice(-100);
    result = {
      ...publicBookImportQueue(store.importQueue),
      queued: deduped.length,
      added,
      alreadyPending: Math.max(0, deduped.length - added)
    };
    return store;
  });

  return result;
}

function publicBookImportQueue(queue = {}) {
  const pending = (queue.pending || []).map((entry) => ({
    key: entry.key,
    input: entry.input,
    addedAt: entry.addedAt || ''
  }));
  const completed = (queue.completed || []).map((entry) => ({
    key: entry.key,
    input: entry.input,
    importedAt: entry.importedAt || '',
    mode: entry.mode || '',
    imported: Number(entry.imported || 0),
    skippedDuplicates: Number(entry.skippedDuplicates || 0),
    updatedDuplicates: Number(entry.updatedDuplicates || 0)
  }));
  const errors = (queue.errors || []).map((entry) => ({
    key: entry.key,
    input: entry.input,
    checkedAt: entry.checkedAt || '',
    error: entry.error || ''
  }));

  return {
    pending,
    completed,
    errors,
    summary: importQueueSummary({ pending, completed, errors })
  };
}

function importQueueSummary(queue = {}) {
  return {
    pendingCount: Array.isArray(queue.pending) ? queue.pending.length : 0,
    completedCount: Array.isArray(queue.completed) ? queue.completed.length : 0,
    errorCount: Array.isArray(queue.errors) ? queue.errors.length : 0
  };
}

export async function saveSettings(settings) {
  const cleaned = {
    notificationThreshold: clampNumber(settings.notificationThreshold, 0, 95, 10),
    checkRunsPerDay: 2,
    checkIntervalHours: 24,
    checkExecutionHourJst: 3,
    checkExecutionMinuteJst: 54,
    secondCheckExecutionHourJst: 15,
    secondCheckExecutionMinuteJst: 54,
    batchSize: floorNumber(settings.batchSize, 1, 50),
    notifyOnPriceDrop: Boolean(settings.notifyOnPriceDrop),
    notifyOnBestEver: Boolean(settings.notifyOnBestEver)
  };

  await updateStore((store) => {
    store.settings = { ...store.settings, ...cleaned };
    return store;
  });

  return cleaned;
}

export async function sendTestNotification() {
  const webhookUrls = await getRuntimeDiscordWebhookUrls();
  const result = await sendDiscordNotification({
    username: 'Kindle Price Watch',
    content: 'Kindle Price Watch のテスト通知です。'
  }, { webhookUrls });
  return result;
}

export async function getDiscordWebhooks() {
  const webhookStore = await readWebhookStore();
  const dedicated = storedDiscordWebhooks(webhookStore);
  if (dedicated != null) {
    return discordWebhooksPayload(dedicated, {
      usingEnvFallback: false,
      source: 'webhook_store'
    });
  }

  const store = await readStore();
  const stored = storedDiscordWebhooks(store.settings);
  const entries = stored ?? getDiscordWebhookUrls().map((url) => ({ name: '', url, enabled: true }));
  return discordWebhooksPayload(entries, {
    usingEnvFallback: stored == null,
    source: stored == null ? 'env' : 'legacy_settings'
  });
}

export async function saveDiscordWebhooks(entries) {
  const cleaned = normalizeDiscordWebhookEntries(entries);
  const activeUrls = activeDiscordWebhookUrls(cleaned);
  await writeWebhookStore(cleaned);
  await updateStore((store) => {
    store.settings = {
      ...store.settings,
      discordWebhooks: cleaned,
      discordWebhookUrls: activeUrls
    };
    return store;
  });
  return discordWebhooksPayload(cleaned, {
    usingEnvFallback: false,
    source: 'webhook_store'
  });
}

export async function getDiscordWebhookCount() {
  const webhooks = await getDiscordWebhooks();
  return webhooks.count;
}

async function getRuntimeDiscordWebhookUrls() {
  const webhooks = await getDiscordWebhooks();
  return webhooks.urls;
}

function storedDiscordWebhookUrls(settings = {}) {
  if (Array.isArray(settings.discordWebhookUrls)) return parseDiscordWebhookUrls(settings.discordWebhookUrls.join('\n'));
  if (typeof settings.discordWebhookUrls === 'string') return parseDiscordWebhookUrls(settings.discordWebhookUrls);
  return null;
}

function storedDiscordWebhooks(settings = {}) {
  if (Array.isArray(settings.discordWebhooks)) return normalizeDiscordWebhookEntries(settings.discordWebhooks);
  const urls = storedDiscordWebhookUrls(settings);
  return urls == null ? null : normalizeDiscordWebhookEntries(urls);
}

function normalizeDiscordWebhookEntries(value) {
  const source = Array.isArray(value) ? value : parseDiscordWebhookUrls(String(value || ''));
  const seen = new Set();
  const entries = [];

  for (const item of source) {
    const entry = normalizeDiscordWebhookEntry(item);
    if (!entry || seen.has(entry.url)) continue;
    if (!isValidDiscordWebhookUrl(entry.url)) {
      const error = new Error('Discord Webhook URL の形式が正しくありません');
      error.status = 400;
      throw error;
    }
    seen.add(entry.url);
    entries.push(entry);
  }

  return entries;
}

function normalizeDiscordWebhookEntry(item) {
  if (typeof item === 'string') {
    const url = item.trim();
    return url ? { name: '', url, enabled: true } : null;
  }

  if (!item || typeof item !== 'object') return null;
  const url = String(item.url || '').trim();
  if (!url) return null;
  return {
    name: String(item.name || '').trim(),
    url,
    enabled: item.enabled !== false
  };
}

function activeDiscordWebhookUrls(entries = []) {
  return entries.filter((entry) => entry.enabled !== false).map((entry) => entry.url);
}

function discordWebhooksPayload(entries, extra = {}) {
  const normalized = normalizeDiscordWebhookEntries(entries);
  const urls = activeDiscordWebhookUrls(normalized);
  return {
    entries: normalized,
    urls,
    count: urls.length,
    totalCount: normalized.length,
    pausedCount: normalized.length - urls.length,
    ...extra
  };
}

function isValidDiscordWebhookUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      /(^|\.)discord(?:app)?\.com$/i.test(url.hostname) &&
      /^\/api\/webhooks\/\d+\/[^/]+$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

async function checkOneBook(bookRef, options = {}) {
  const now = new Date().toISOString();
  const snapshotResult = await settleSnapshot(bookRef.asin, bookRef, {
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
  let applied = { checkedBook: null, events: [] };

  await updateStore((store) => {
    applied = applyCheckResultToStore(store, bookRef, snapshotResult, now, {
      updateCursor: options.updateCursor
    });
    return store;
  });

  const sent = await sendCheckNotifications(applied.checkedBook, applied.events, options);

  return checkResultPayload(applied.checkedBook, snapshotResult, applied.events, sent);
}

async function checkOneBookInStore(store, bookRef, options = {}) {
  const now = new Date().toISOString();
  const snapshotResult = await settleSnapshot(bookRef.asin, bookRef, {
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
  const applied = applyCheckResultToStore(store, bookRef, snapshotResult, now, {
    updateCursor: options.updateCursor
  });
  const sent = await sendCheckNotifications(applied.checkedBook, applied.events, {
    ...options,
    notificationStore: store
  });
  return checkResultPayload(applied.checkedBook, snapshotResult, applied.events, sent);
}

function applyCheckResultToStore(store, bookRef, snapshotResult, now, options = {}) {
  const settings = mergedRuntimeSettings(store.settings);
  const book = store.books.find((item) => item.id === bookRef.id);
  if (!book) return { checkedBook: null, events: [] };

  const previousEffectivePrice = book.effectivePrice;
  const previousLowestEffectivePrice = book.lowestEffectivePrice;
  const seriesScope = notificationSeriesScope(book);
  const seriesBaseline =
    snapshotResult.ok && seriesScope ? captureSeriesNotificationBaseline(store, seriesScope, options) : null;

  if (!snapshotResult.ok) {
    if (snapshotResult.snapshot) {
      applyMetadataSnapshotToBook(book, snapshotResult.snapshot);
    }
    const repair = repairSuspiciousPriceState(book, store, {
      clearCurrent: true,
      restoreMissingCurrent: true
    });
    if (isPermanentSnapshotError(snapshotResult.error)) {
      book.lastCheckedAt = now;
    } else if (
      isUnresolvedSingleBook(book) ||
      (repair.currentCleared && !repair.currentRestored) ||
      isSuspiciousSnapshotError(snapshotResult.error)
    ) {
      book.lastCheckedAt = null;
    } else if (!repair.currentRestored) {
      book.lastCheckedAt = now;
    }
    book.updatedAt = now;
    book.lastError = shouldStoreSnapshotError(book, snapshotResult.error) ? snapshotResult.error : '';
    if (options.updateCursor) updateCheckCursor(store, book, now);
    return { checkedBook: { ...book }, events: [] };
  }

  const snapshot = snapshotResult.snapshot;
  book.title = preferSnapshotText(snapshot.title, book.title);
  book.author = snapshot.author || book.author;
  book.publisher = snapshot.publisher || book.publisher;
  book.imageUrl = snapshot.imageUrl || book.imageUrl;
  book.imageSource = snapshot.imageUrl ? snapshot.provider || book.imageSource || '' : book.imageSource || '';
  book.amazonUrl = snapshot.amazonUrl || book.amazonUrl;
  book.previousEffectivePrice = previousEffectivePrice;
  book.currentPrice = snapshot.currentPrice;
  book.currentPoints = snapshot.currentPoints;
  book.effectivePrice = snapshot.effectivePrice;
  book.listPrice = snapshot.listPrice ?? book.listPrice;
  book.provider = snapshot.provider;
  book.lastCheckedAt = now;
  book.updatedAt = now;
  book.lastError = '';
  repairStoredBookTitle(book);
  if (options.updateCursor) updateCheckCursor(store, book, now);

  if (snapshot.currentPrice != null) {
    book.lowestPrice = minNullable(book.lowestPrice, snapshot.currentPrice);
  }
  if (snapshot.effectivePrice != null) {
    book.lowestEffectivePrice = minNullable(book.lowestEffectivePrice, snapshot.effectivePrice);
    appendPriceHistoryEntry(store, book, now);
  }
  repairSuspiciousPriceState(book, store);

  const events = notificationEventsForCheckedBook(store, book, {
    options,
    previousEffectivePrice,
    previousLowestEffectivePrice,
    seriesBaseline,
    seriesScope,
    settings
  });

  if (options.recordNotifications !== false) {
    recordNotificationEvents(store, book, events, now);
  }

  return { checkedBook: { ...book }, events };
}

function notificationEventsForCheckedBook(store, book, context = {}) {
  if (context.options?.recordNotifications === false) return [];

  if (context.seriesScope) {
    if (context.options?.deferSeriesNotifications) return [];
    const after = seriesAggregateSnapshot(store, context.seriesScope);
    return detectSeriesEvents({
      before: context.seriesBaseline,
      after,
      settings: context.settings
    }).filter((event) => !alreadyNotifiedSeries(store, event));
  }

  return detectEvents({
    book,
    previousEffectivePrice: context.previousEffectivePrice,
    previousLowestEffectivePrice: context.previousLowestEffectivePrice,
    settings: context.settings
  }).filter((event) => !alreadyNotified(store, book.id, event));
}

function captureSeriesNotificationBaseline(store, seriesScope, options = {}) {
  if (!seriesScope) return null;

  if (options.deferSeriesNotifications && options.seriesNotificationBaselines) {
    const existing = options.seriesNotificationBaselines.get(seriesScope.key);
    if (existing) return existing;

    const baseline = seriesAggregateSnapshot(store, seriesScope);
    baseline.freshAfter = options.seriesFreshAfter || '';
    options.seriesNotificationBaselines.set(seriesScope.key, baseline);
    return baseline;
  }

  return seriesAggregateSnapshot(store, seriesScope);
}

async function sendDeferredSeriesNotifications(store, baselines, options = {}) {
  const sent = [];
  if (options.recordNotifications === false) return sent;
  if (!baselines || baselines.size === 0) return sent;

  const settings = mergedRuntimeSettings(store.settings);
  const now = new Date().toISOString();
  for (const baseline of baselines.values()) {
    let after = seriesAggregateSnapshot(store, baseline.scope, { freshAfter: baseline.freshAfter });
    appendSeriesPriceHistoryEntry(store, after, now);
    after = seriesAggregateSnapshot(store, baseline.scope, { freshAfter: baseline.freshAfter });
    const representativeBook = after.representativeBook || baseline.representativeBook;
    if (!representativeBook) continue;

    const events = detectSeriesEvents({ before: baseline, after, settings }).filter(
      (event) => !alreadyNotifiedSeries(store, event)
    );
    if (events.length === 0) continue;

    if (options.recordNotifications !== false) {
      recordNotificationEvents(store, representativeBook, events, now);
    }

    sent.push(
      ...(await sendCheckNotifications(representativeBook, events, {
        ...options,
        notificationStore: store
      }))
    );
  }

  return sent;
}

function recordNotificationEvents(store, book, events, now) {
  for (const event of events) {
    const notificationBookId = event.notificationBookId || book.id;
    store.notifications.push({
      id: crypto.randomUUID(),
      bookId: notificationBookId,
      asin: event.asin || book.asin,
      scope: event.scope || 'book',
      seriesKey: event.seriesKey || '',
      seriesName: event.seriesName || '',
      notificationKey: event.notificationKey || '',
      type: event.type,
      effectivePrice: event.effectivePrice ?? book.effectivePrice,
      previousEffectivePrice: event.previousEffectivePrice,
      createdAt: now,
      status: 'pending'
    });
  }
}

async function sendCheckNotifications(checkedBook, events, options = {}) {
  const sent = [];
  if (options.notify === false || !checkedBook || events.length === 0) return sent;

  const webhookUrls = await notificationWebhookUrls(options);
  for (const event of events) {
    const notificationBook = event.notificationBook || checkedBook;
    const notificationBookId = event.notificationBookId || checkedBook.id;
    const notification = buildPriceNotification(notificationBook, event);
    try {
      await sendDiscordNotification(notification, { webhookUrls });
      sent.push({ type: event.type, scope: event.scope || 'book', seriesKey: event.seriesKey || '', ok: true });
      if (options.notificationStore) {
        markNotificationInStore(options.notificationStore, notificationBookId, event, 'sent');
      } else {
        await markNotification(notificationBookId, event, 'sent');
      }
    } catch (error) {
      sent.push({
        type: event.type,
        scope: event.scope || 'book',
        seriesKey: event.seriesKey || '',
        ok: false,
        error: error.message
      });
      if (options.notificationStore) {
        markNotificationInStore(options.notificationStore, notificationBookId, event, 'failed', error.message);
      } else {
        await markNotification(notificationBookId, event, 'failed', error.message);
      }
    }
  }
  return sent;
}

function checkResultPayload(checkedBook, snapshotResult, events, notifications) {
  return {
    book: checkedBook ? publicBook(checkedBook) : null,
    ok: snapshotResult.ok,
    error: snapshotResult.ok ? null : snapshotResult.error,
    events: events.map(publicNotificationEvent),
    notifications
  };
}

function publicNotificationEvent(event) {
  const { notificationBook, ...publicEvent } = event;
  return publicEvent;
}

async function sendCronSummaryNotification(result, context = {}) {
  if (context.options?.notify === false) return null;
  if (context.source !== 'cron' && context.source !== 'scheduler') return null;
  if (result.skipped) return null;
  if (!shouldPersistCronRun(result)) return null;

  try {
    const webhookUrls = typeof context.getWebhookUrls === 'function'
      ? await context.getWebhookUrls()
      : await getRuntimeDiscordWebhookUrls();
    const message = buildCronSummaryNotification(cronSummaryPayload(result, context));
    return await sendDiscordNotification(message, { webhookUrls });
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function cronSummaryPayload(result, context = {}) {
  const notifications = [
    ...(result.results || []).flatMap((entry) => entry.notifications || []),
    ...(result.seriesNotifications || [])
  ];
  return {
    source: context.source || 'cron',
    startedAt: context.startedAt,
    finishedAt: context.finishedAt,
    durationMs: context.durationMs,
    checked: result.checked,
    remainingDue: result.remainingDue,
    stoppedByRuntimeLimit: result.stoppedByRuntimeLimit,
    forced: result.forced,
    resultErrors: (result.results || []).filter((entry) => entry?.ok === false || entry?.error).length,
    notificationSent: notifications.filter((entry) => entry.ok === true).length,
    notificationFailed: notifications.filter((entry) => entry.ok === false).length,
    importQueue: result.importQueue
      ? {
          processed: result.importQueue.processed || 0,
          imported: result.importQueue.imported || 0,
          errors: result.importQueue.errors?.length || 0
        }
      : null,
    seriesDiscovery: result.seriesDiscovery
      ? {
          checked: result.seriesDiscovery.checked || 0,
          added: result.seriesDiscovery.added || 0,
          completed: result.seriesDiscovery.completed || 0,
          skippedNoRun: result.seriesDiscovery.skippedNoRun || 0,
          skippedCompleted: result.seriesDiscovery.skippedCompleted || 0,
          markedNoRun: result.seriesDiscovery.markedNoRun || 0,
          errors: result.seriesDiscovery.errors?.length || 0
        }
      : null
  };
}

async function notificationWebhookUrls(options = {}) {
  if (Array.isArray(options.webhookUrls)) return options.webhookUrls;
  if (typeof options.getWebhookUrls === 'function') return options.getWebhookUrls();
  return getRuntimeDiscordWebhookUrls();
}

function sharedWebhookUrlLoader() {
  let promise;
  return async () => {
    promise ||= getRuntimeDiscordWebhookUrls();
    return promise;
  };
}

async function settleSnapshot(asin, book = {}, options = {}) {
  try {
    const snapshot = await fetchBookSnapshot(asin, {
      ...book,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      url: options.url || book.sourceUrl || book.amazonUrl || ''
    });
    if (snapshot.currentPrice == null) return { ok: false, snapshot, error: '価格を取得できませんでした' };
    const suspiciousReason = suspiciousSnapshotReason(book, snapshot);
    if (suspiciousReason) {
      return {
        ok: false,
        snapshot,
        error: `疑わしい価格を無視しました (${suspiciousReason})`
      };
    }
    return { ok: true, snapshot };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function settleSnapshotWithUrl(asin, url, book = {}) {
  if (!asin) return { ok: false, error: 'Amazon URL または ASIN を入力してください' };
  try {
    const snapshot = await fetchBookSnapshot(asin, { ...book, url });
    if (snapshot.currentPrice == null) return { ok: false, snapshot, error: '価格を取得できませんでした' };
    const suspiciousReason = suspiciousSnapshotReason(book || {}, snapshot);
    if (suspiciousReason) {
      return {
        ok: false,
        snapshot,
        error: `疑わしい価格を無視しました (${suspiciousReason})`
      };
    }
    return { ok: true, snapshot };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function applyMetadataSnapshotToBook(book, snapshot) {
  if (!book || !snapshot) return;
  book.title = preferSnapshotText(snapshot.title, book.title);
  book.author = snapshot.author || book.author;
  book.publisher = snapshot.publisher || book.publisher;
  book.imageUrl = snapshot.imageUrl || book.imageUrl;
  book.imageSource = snapshot.imageUrl ? snapshot.provider || book.imageSource || '' : book.imageSource || '';
  book.amazonUrl = snapshot.amazonUrl || book.amazonUrl;
  if (!book.provider || book.provider === 'pending') book.provider = snapshot.provider || book.provider;
  repairStoredBookTitle(book);
}

function normalizeImageUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  try {
    const url = new URL(text);
    url.search = '';
    return url.toString();
  } catch {
    return text.replace(/\?.*$/, '');
  }
}

async function findBookByAsin(asin) {
  const store = await readStore();
  return store.books.find((book) => book.asin === asin);
}

async function findBookById(id) {
  const store = await readStore();
  return store.books.find((book) => book.id === id);
}

async function buildBookFromAsin(asin, options = {}) {
  const fetchDetails = options.fetchDetails !== false;
  const seed = options.seed || {};
  const seedPriceIsUnvalidated =
    isUnvalidatedSeriesPriceProvider(seed.provider) || isUnverifiedFreeSeriesPriceProvider(seed.provider, seed.currentPrice);
  const seedCurrentPrice = seedPriceIsUnvalidated ? null : seed.currentPrice ?? null;
  const now = options.createdAt || new Date().toISOString();
  let snapshot;
  let lastError = '';

  if (fetchDetails) {
    try {
      snapshot = await fetchBookSnapshot(asin, {
        ...seed,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        url: options.inputUrl || seed.amazonUrl || '',
        sourceUrl: options.sourceUrl || seed.sourceUrl || ''
      });
    } catch (error) {
      lastError = error.message;
    }
  } else {
    lastError =
      seedCurrentPrice == null
        ? seed.lastError ||
          (seedPriceIsUnvalidated
            ? '未検証のシリーズ価格を破棄しました。次回チェックで再取得します'
            : 'シリーズ一括登録: 次回チェックで詳細取得します')
        : '';
  }

  const fallbackProvider = seedPriceIsUnvalidated
    ? (fetchDetails ? 'pending' : 'pending_series')
    : seed.provider || (fetchDetails ? 'pending' : 'pending_series');
  const fallbackCurrentPrice = seedCurrentPrice;
  const fallbackListPrice = trustedListPriceFor(fallbackCurrentPrice, seed.listPrice, fallbackProvider);
  const fallback = {
    asin,
    title: seed.title || `ASIN ${asin}`,
    author: seed.author || '',
    publisher: seed.publisher || '',
    imageUrl: seed.imageUrl || '',
    imageSource: seed.imageSource || '',
    amazonUrl: seed.amazonUrl || amazonUrlForAsin(asin),
    currentPrice: fallbackCurrentPrice,
    currentPoints: seedPriceIsUnvalidated ? 0 : seed.currentPoints ?? 0,
    effectivePrice: seedPriceIsUnvalidated ? null : seed.effectivePrice ?? effectivePriceFromSeed(seed),
    listPrice: fallbackListPrice,
    provider: fallbackProvider
  };
  snapshot = mergeSnapshot(fallback, snapshot);
  if (snapshot.currentPrice == null && !lastError) {
    lastError = '価格を取得できませんでした';
  }

  return {
    id: crypto.randomUUID(),
    asin,
    title: snapshot.title,
    author: snapshot.author,
    publisher: snapshot.publisher,
    seriesKey: options.seriesKey || '',
    seriesName: options.seriesName || seed.seriesName || '',
    volume: options.volume || seed.volume || '',
    seriesExpectedCount: options.seriesExpectedCount || seed.seriesExpectedCount || '',
    imageUrl: snapshot.imageUrl,
    imageSource: snapshot.imageSource || seed.imageSource || snapshot.provider || '',
    amazonUrl: snapshot.amazonUrl,
    currentPrice: snapshot.currentPrice,
    currentPoints: snapshot.currentPoints,
    effectivePrice: snapshot.effectivePrice,
    listPrice: snapshot.listPrice,
    lowestPrice: snapshot.currentPrice,
    lowestEffectivePrice: snapshot.effectivePrice,
    previousEffectivePrice: null,
    provider: snapshot.provider,
    sourceUrl: options.sourceUrl || seed.sourceUrl || '',
    importMode: options.importMode || 'single',
    seriesCompleted: Boolean(options.seriesCompleted || seed.seriesCompleted),
    seriesCompletedAt: options.seriesCompleted || seed.seriesCompleted ? now : '',
    seriesLastDiscoveredAt: options.seriesLastDiscoveredAt || '',
    seriesDiscoveryStatus: '',
    seriesDiscoverySkipReason: '',
    seriesDiscoverySkippedAt: '',
    seriesDiscoveryError: '',
    lastCheckedAt: snapshot.currentPrice == null ? null : now,
    createdAt: now,
    updatedAt: now,
    lastError
  };
}

function mergeSnapshot(fallback, snapshot) {
  if (!snapshot) return fallback;
  return {
    asin: snapshot.asin || fallback.asin,
    title: preferSnapshotText(snapshot.title, fallback.title),
    author: snapshot.author || fallback.author,
    publisher: snapshot.publisher || fallback.publisher,
    imageUrl: snapshot.imageUrl || fallback.imageUrl,
    imageSource: snapshot.imageUrl ? snapshot.provider || fallback.imageSource : fallback.imageSource,
    amazonUrl: snapshot.amazonUrl || fallback.amazonUrl,
    currentPrice: snapshot.currentPrice ?? fallback.currentPrice,
    currentPoints: snapshot.currentPoints ?? fallback.currentPoints,
    effectivePrice: snapshot.effectivePrice ?? fallback.effectivePrice,
    listPrice: snapshot.listPrice ?? fallback.listPrice,
    provider: snapshot.provider || fallback.provider
  };
}

function effectivePriceFromSeed(seed) {
  if (seed.currentPrice == null) return null;
  return Math.max(0, Math.round(Number(seed.currentPrice) - Number(seed.currentPoints || 0)));
}

function preferSnapshotText(snapshotText, fallbackText) {
  if (!snapshotText || /^ASIN\s+[A-Z0-9]{10}$/i.test(snapshotText)) return fallbackText;
  if (isAmazonErrorPageBookTitle(snapshotText)) return fallbackText;
  return snapshotText;
}

function repairStoredBookTitle(book) {
  if (!book || !isAmazonErrorPageBookTitle(book.title)) return false;
  const fallback = fallbackBookTitle(book);
  if (!fallback || fallback === book.title) return false;
  book.title = fallback;
  return true;
}

function fallbackBookTitle(book) {
  if (book?.seriesName && book?.volume) return `${book.seriesName} ${book.volume}`;
  if (book?.asin) return `ASIN ${book.asin}`;
  return '';
}

function isAmazonErrorPageBookTitle(title) {
  const value = String(title || '').replace(/\s+/g, '');
  return (
    /(?:503|ServiceUnavailable|サービスが利用できません)/i.test(value) ||
    /(?:RobotCheck|CAPTCHA|ショッピングを続けてください)/i.test(value) ||
    /^URLSource:/i.test(value) ||
    /^Amazon\.co\.jp$/i.test(value)
  );
}

function isUnresolvedSingleBook(book) {
  if (!book || book.currentPrice != null) return false;
  if ((book.importMode || 'single') !== 'single') return false;
  if (book.effectivePrice == null) return true;
  const title = String(book.title || '');
  return (
    /^ASIN\s+[A-Z0-9]{10}$/i.test(title) ||
    isAmazonErrorPageBookTitle(title) ||
    book.provider === 'pending'
  );
}

function seriesKeyForSeries(input, series = {}) {
  const asin = series.sourceAsin || extractAsin(input);
  if (asin) return `series:asin:${asin}`;
  return `series:${crypto.createHash('sha1').update(String(input || '').trim()).digest('hex').slice(0, 16)}`;
}

function seriesSourceUrlFor(input, series = {}) {
  const asin = series.sourceAsin || extractAsin(input);
  return asin ? kindleSeriesUrlForAsin(asin) : String(input || '').trim();
}

function kindleSeriesUrlForAsin(asin) {
  const url = new URL(amazonUrlForAsin(asin));
  url.searchParams.set('binding', 'kindle_edition');
  url.searchParams.set('ref_', 'dbs_s_ks_series_rwt_tkin');
  return url.toString();
}

function isSameSeriesSource(left, right, sourceAsin = '') {
  if (!left || !right) return false;
  if (String(left).trim() === String(right).trim()) return true;

  const leftAsin = extractAsin(left);
  const rightAsin = extractAsin(right);
  const expected = String(sourceAsin || '').toUpperCase();
  if (expected) return leftAsin === expected && rightAsin === expected;
  return Boolean(leftAsin && rightAsin && leftAsin === rightAsin);
}

function historyEntry(book, checkedAt) {
  return {
    id: crypto.randomUUID(),
    bookId: book.id,
    asin: book.asin,
    price: book.currentPrice,
    points: book.currentPoints || 0,
    effectivePrice: book.effectivePrice,
    listPrice: book.listPrice,
    provider: book.provider,
    checkedAt
  };
}

function appendPriceHistoryEntry(store, book, checkedAt) {
  if (book.effectivePrice == null) return false;
  const entry = historyEntry(book, checkedAt);
  const latest = latestPriceHistoryEntry(store, book.id);
  if (latest && samePriceHistoryState(latest, entry)) return false;
  store.priceHistory.push(entry);
  return true;
}

function latestPriceHistoryEntry(store, bookId) {
  return store.priceHistory
    .filter((entry) => entry.bookId === bookId)
    .sort((a, b) => new Date(b.checkedAt || 0) - new Date(a.checkedAt || 0))[0] || null;
}

function compactPriceHistory(store) {
  if (!Array.isArray(store.priceHistory) || store.priceHistory.length === 0) return { removed: 0 };

  const originalCount = store.priceHistory.length;
  const maxEntriesPerBook = floorNumber(process.env.PRICE_HISTORY_MAX_ENTRIES_PER_BOOK, 1, 120);
  const existingBookIds = new Set((store.books || []).map((book) => book.id));
  const byBook = new Map();

  for (const entry of store.priceHistory) {
    if (!entry?.bookId || !existingBookIds.has(entry.bookId)) continue;
    if (!byBook.has(entry.bookId)) byBook.set(entry.bookId, []);
    byBook.get(entry.bookId).push(entry);
  }

  const compacted = [];
  for (const entries of byBook.values()) {
    const reduced = [];
    for (const entry of entries.sort((a, b) => new Date(a.checkedAt || 0) - new Date(b.checkedAt || 0))) {
      const previous = reduced[reduced.length - 1];
      if (previous && samePriceHistoryState(previous, entry)) continue;
      reduced.push(entry);
    }
    compacted.push(...reduced.slice(-maxEntriesPerBook));
  }

  store.priceHistory = compacted.sort((a, b) => new Date(a.checkedAt || 0) - new Date(b.checkedAt || 0));
  return { removed: originalCount - store.priceHistory.length };
}

function compactSeriesPriceHistory(store) {
  if (!Array.isArray(store.seriesPriceHistory)) {
    store.seriesPriceHistory = [];
    return { removed: 0 };
  }
  if (store.seriesPriceHistory.length === 0) return { removed: 0 };

  const originalCount = store.seriesPriceHistory.length;
  const contexts = activeSeriesHistoryContexts(store);
  const maxEntriesPerSeries = floorNumber(process.env.SERIES_PRICE_HISTORY_MAX_ENTRIES_PER_SERIES, 1, 120);
  const bySeries = new Map();

  for (const entry of store.seriesPriceHistory) {
    const context = seriesHistoryContextForEntry(entry, contexts);
    if (!context) continue;
    if (Number(entry.bookCount || 0) !== context.bookCount) continue;
    if (nullableNumber(entry.effectivePriceTotal) == null) continue;
    if (!bySeries.has(context.key)) bySeries.set(context.key, []);
    bySeries.get(context.key).push({ ...entry, key: context.key });
  }

  const compacted = [];
  for (const entries of bySeries.values()) {
    const reduced = [];
    for (const entry of entries.sort(compareSeriesHistoryEntriesAscending)) {
      const previous = reduced[reduced.length - 1];
      if (previous && sameSeriesPriceHistoryState(previous, entry)) continue;
      reduced.push(entry);
    }

    const selected = reduced.slice(-maxEntriesPerSeries);
    const lowest = lowestSeriesPriceHistoryEntry(reduced);
    if (lowest && !selected.includes(lowest)) selected.unshift(lowest);
    compacted.push(...selected);
  }

  store.seriesPriceHistory = compacted.sort(compareSeriesHistoryEntriesAscending);
  return { removed: originalCount - store.seriesPriceHistory.length };
}

function activeSeriesHistoryContexts(store) {
  const contexts = [];
  const seen = new Set();
  for (const book of store.books || []) {
    const scope = notificationSeriesScope(book);
    if (!scope || seen.has(scope.key)) continue;
    const bookCount = seriesBooksForNotification(store, scope).length;
    contexts.push({ ...scope, bookCount });
    seen.add(scope.key);
  }
  return contexts;
}

function seriesHistoryContextForEntry(entry, contexts) {
  return contexts.find((context) => seriesHistoryEntryMatchesScope(entry, context)) || null;
}

function seriesHistoryEntryMatchesScope(entry, scope) {
  if (!entry || !scope) return false;
  if (entry.seriesKey && scope.seriesKey && entry.seriesKey === scope.seriesKey) return true;
  if (entry.sourceUrl && scope.sourceUrl && entry.sourceUrl === scope.sourceUrl) return true;
  return Boolean(entry.key && scope.key && entry.key === scope.key);
}

function samePriceHistoryState(left, right) {
  return (
    nullableNumber(left.price) === nullableNumber(right.price) &&
    nullableNumber(left.points) === nullableNumber(right.points) &&
    nullableNumber(left.effectivePrice) === nullableNumber(right.effectivePrice) &&
    nullableNumber(left.listPrice) === nullableNumber(right.listPrice)
  );
}

function sameSeriesPriceHistoryState(left, right) {
  return (
    nullableNumber(left.currentPriceTotal) === nullableNumber(right.currentPriceTotal) &&
    nullableNumber(left.currentPointsTotal) === nullableNumber(right.currentPointsTotal) &&
    nullableNumber(left.effectivePriceTotal) === nullableNumber(right.effectivePriceTotal) &&
    Number(left.bookCount || 0) === Number(right.bookCount || 0) &&
    Number(left.pricedCount || 0) === Number(right.pricedCount || 0)
  );
}

function compareSeriesHistoryEntriesAscending(left, right) {
  return new Date(left.checkedAt || 0) - new Date(right.checkedAt || 0);
}

function lowestSeriesPriceHistoryEntry(entries) {
  return [...entries]
    .filter((entry) => nullableNumber(entry.effectivePriceTotal) != null)
    .sort((left, right) => {
      const priceDiff = Number(left.effectivePriceTotal) - Number(right.effectivePriceTotal);
      if (priceDiff !== 0) return priceDiff;
      return new Date(right.checkedAt || 0) - new Date(left.checkedAt || 0);
    })[0] || null;
}

function priceStateForComparison(book) {
  return {
    title: book.title || '',
    currentPrice: book.currentPrice ?? null,
    currentPoints: book.currentPoints ?? 0,
    effectivePrice: book.effectivePrice ?? null,
    listPrice: book.listPrice ?? null,
    lowestPrice: book.lowestPrice ?? null,
    lowestEffectivePrice: book.lowestEffectivePrice ?? null,
    provider: book.provider || '',
    lastCheckedAt: book.lastCheckedAt || '',
    lastError: book.lastError || ''
  };
}

function nullableNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicBookWithSeriesHistory(book, seriesHistory) {
  const result = publicBook(book);
  const scope = notificationSeriesScope(book);
  const summary = scope ? seriesHistory.get(scope.key) : null;
  if (!summary) return result;

  return {
    ...result,
    seriesLowestEffectiveTotal: summary.lowestEffectiveTotal,
    seriesLowestCheckedAt: summary.lowestCheckedAt,
    seriesLatestObservedEffectiveTotal: summary.latestObservedEffectiveTotal,
    seriesLatestObservedAt: summary.latestObservedAt,
    seriesObservedBookCount: summary.bookCount,
    seriesObservedHistoryCount: summary.historyCount
  };
}

function seriesHistorySummaries(store) {
  const summaries = new Map();
  const seen = new Set();
  for (const book of store.books || []) {
    const scope = notificationSeriesScope(book);
    if (!scope || seen.has(scope.key)) continue;
    const snapshot = seriesAggregateSnapshot(store, scope);
    if (snapshot.observedHistoryCount > 0) {
      summaries.set(scope.key, {
        lowestEffectiveTotal: snapshot.lowestEffectiveTotal,
        lowestCheckedAt: snapshot.lowestObservedAt,
        latestObservedEffectiveTotal: snapshot.latestObservedEffectiveTotal,
        latestObservedAt: snapshot.latestObservedAt,
        bookCount: snapshot.bookCount,
        historyCount: snapshot.observedHistoryCount
      });
    }
    seen.add(scope.key);
  }
  return summaries;
}

function notificationSeriesScope(book) {
  if (!book || (book.importMode !== 'kindle_series' && !book.seriesKey)) return null;

  const seriesKey = String(book.seriesKey || '').trim();
  const sourceUrl = String(book.sourceUrl || '').trim();
  const key = seriesKey || (sourceUrl ? `series:url:${sourceUrl}` : '');
  if (!key) return null;

  return { key, seriesKey, sourceUrl };
}

function seriesAggregateSnapshot(store, scope, options = {}) {
  const books = seriesBooksForNotification(store, scope);
  const representativeBook = books[0] || null;
  const seriesName =
    books.find((book) => String(book.seriesName || '').trim())?.seriesName ||
    (representativeBook ? seriesTitleFromBook(representativeBook) : 'Kindle シリーズ');
  const sourceUrl = books.find((book) => String(book.sourceUrl || '').trim())?.sourceUrl || scope?.sourceUrl || '';
  const seriesKey = scope?.seriesKey || books.find((book) => String(book.seriesKey || '').trim())?.seriesKey || '';
  const currentPrices = books.map((book) => nullableNumber(book.currentPrice));
  const currentPoints = books.map((book) => nullableNumber(book.currentPoints) ?? 0);
  const currentEffectivePrices = books.map((book) => nullableNumber(book.effectivePrice));
  const checkedTimes = books
    .map((book) => timestampMs(book.lastCheckedAt))
    .filter((time) => time > 0)
    .sort((left, right) => left - right);
  const freshAfterMs = new Date(options.freshAfter || 0).getTime();
  const requiresFreshCheck = Number.isFinite(freshAfterMs) && freshAfterMs > 0;
  const freshCheckedCount = requiresFreshCheck
    ? books.filter((book) => {
        const checkedAt = new Date(book.lastCheckedAt || 0).getTime();
        return Number.isFinite(checkedAt) && checkedAt >= freshAfterMs;
      }).length
    : books.length;

  const snapshot = {
    scope,
    key: scope?.key || seriesKey || sourceUrl,
    seriesKey,
    seriesName,
    sourceUrl,
    url: canonicalSeriesNotificationUrl({ seriesKey, sourceUrl, representativeBook }),
    representativeBook,
    bookCount: books.length,
    pricedCount: currentEffectivePrices.filter((value) => value != null).length,
    freshCheckedCount,
    requiresFreshCheck,
    currentPriceTotal: sumWhenComplete(currentPrices),
    currentPointsTotal: currentPrices.every((value) => value != null) ? sumNumbers(currentPoints) : null,
    currentEffectiveTotal: sumWhenComplete(currentEffectivePrices),
    observedFrom: checkedTimes.length === books.length ? new Date(checkedTimes[0]).toISOString() : '',
    observedTo: checkedTimes.length === books.length ? new Date(checkedTimes[checkedTimes.length - 1]).toISOString() : ''
  };

  const observed = seriesObservedPriceStats(store, snapshot);
  snapshot.observedHistoryCount = observed.count;
  snapshot.latestObservedEffectiveTotal = observed.latest?.effectivePriceTotal ?? null;
  snapshot.latestObservedAt = observed.latest?.checkedAt || '';
  snapshot.lowestEffectiveTotal = observed.lowest?.effectivePriceTotal ?? null;
  snapshot.lowestObservedAt = observed.lowest?.checkedAt || '';
  snapshot.lowestPricedCount = observed.lowest ? snapshot.bookCount : 0;
  snapshot.currentTotalRecordable = canRecordSeriesAggregateSnapshot(snapshot);
  snapshot.currentTotalObserved =
    snapshot.currentTotalRecordable &&
    observed.latest &&
    nullableNumber(observed.latest.effectivePriceTotal) === nullableNumber(snapshot.currentEffectiveTotal);

  return snapshot;
}

function seriesAggregateFreshAfter(now = Date.now(), settings = {}) {
  const timestamp = Number(now);
  const base = Number.isFinite(timestamp) ? timestamp : Date.now();
  return new Date(recentJstExecutionBoundaryMs(base, settings, seriesAggregateObservationRuns()));
}

function recentJstExecutionBoundaryMs(now, settings = {}, runCount = 5) {
  const count = floorNumber(runCount, 1, 5);
  const dayMs = 24 * 60 * 60 * 1000;
  const times = scheduledExecutionTimes(settings).sort(
    (left, right) => left.hour * 60 + left.minute - (right.hour * 60 + right.minute)
  );
  const boundaries = [];

  for (let dayOffset = 0; boundaries.length < count && dayOffset <= count; dayOffset += 1) {
    for (const time of [...times].reverse()) {
      const boundary = todayJstExecutionBoundaryMs(now, time) - dayOffset * dayMs;
      if (boundary <= now) boundaries.push(boundary);
      if (boundaries.length >= count) break;
    }
  }

  return boundaries[count - 1] ?? latestJstExecutionBoundaryMs(now, settings);
}

function seriesAggregateObservationRuns() {
  return floorNumber(process.env.SERIES_TOTAL_OBSERVATION_RUNS, 1, 5);
}

function appendSeriesPriceHistoryEntry(store, snapshot, checkedAt) {
  if (!canRecordSeriesAggregateSnapshot(snapshot)) return false;
  const entry = seriesPriceHistoryEntry(snapshot, checkedAt);
  store.seriesPriceHistory ||= [];
  const latest = latestSeriesPriceHistoryEntry(store, snapshot);
  if (latest && sameSeriesPriceHistoryState(latest, entry)) return false;
  store.seriesPriceHistory.push(entry);
  return true;
}

function seriesPriceHistoryEntry(snapshot, checkedAt) {
  return {
    id: crypto.randomUUID(),
    key: snapshot.key,
    seriesKey: snapshot.seriesKey,
    sourceUrl: snapshot.sourceUrl,
    seriesName: snapshot.seriesName,
    bookCount: snapshot.bookCount,
    pricedCount: snapshot.pricedCount,
    currentPriceTotal: snapshot.currentPriceTotal,
    currentPointsTotal: snapshot.currentPointsTotal || 0,
    effectivePriceTotal: snapshot.currentEffectiveTotal,
    observedFrom: snapshot.observedFrom || '',
    observedTo: snapshot.observedTo || '',
    checkedAt: snapshot.observedTo || checkedAt || new Date().toISOString()
  };
}

function canRecordSeriesAggregateSnapshot(snapshot) {
  return Boolean(
    snapshot &&
      snapshot.bookCount > 0 &&
      snapshot.pricedCount === snapshot.bookCount &&
      snapshot.currentEffectiveTotal != null &&
      (!snapshot.requiresFreshCheck || snapshot.freshCheckedCount === snapshot.bookCount)
  );
}

function seriesObservedPriceStats(store, snapshot) {
  const entries = seriesPriceHistoryEntriesForSnapshot(store, snapshot);
  return {
    count: entries.length,
    latest: latestSeriesPriceHistoryEntryFromEntries(entries),
    lowest: lowestSeriesPriceHistoryEntry(entries)
  };
}

function latestSeriesPriceHistoryEntry(store, snapshot) {
  return latestSeriesPriceHistoryEntryFromEntries(seriesPriceHistoryEntriesForSnapshot(store, snapshot));
}

function latestSeriesPriceHistoryEntryFromEntries(entries) {
  return [...entries].sort((left, right) => new Date(right.checkedAt || 0) - new Date(left.checkedAt || 0))[0] || null;
}

function seriesPriceHistoryEntriesForSnapshot(store, snapshot) {
  if (!Array.isArray(store.seriesPriceHistory) || !snapshot) return [];
  return store.seriesPriceHistory.filter((entry) => {
    if (!seriesHistoryEntryMatchesScope(entry, snapshot)) return false;
    if (Number(entry.bookCount || 0) !== Number(snapshot.bookCount || 0)) return false;
    if (Number(entry.pricedCount || entry.bookCount || 0) !== Number(snapshot.bookCount || 0)) return false;
    return nullableNumber(entry.effectivePriceTotal) != null;
  });
}

function seriesBooksForNotification(store, scope) {
  if (!scope) return [];
  return (store.books || [])
    .filter((book) => {
      if (scope.seriesKey) return book.seriesKey === scope.seriesKey;
      return (
        scope.sourceUrl &&
        book.sourceUrl === scope.sourceUrl &&
        (book.importMode === 'kindle_series' || Boolean(book.seriesKey))
      );
    })
    .sort(compareNotificationSeriesBooks);
}

function compareNotificationSeriesBooks(left, right) {
  const leftVolume = Number(left.volume);
  const rightVolume = Number(right.volume);
  if (Number.isFinite(leftVolume) && Number.isFinite(rightVolume) && leftVolume !== rightVolume) {
    return leftVolume - rightVolume;
  }
  return String(left.title || left.asin || '').localeCompare(String(right.title || right.asin || ''), 'ja');
}

function sumWhenComplete(values) {
  if (values.length === 0 || values.some((value) => value == null)) return null;
  return sumNumbers(values);
}

function sumNumbers(values) {
  return values.reduce((sum, value) => sum + Number(value || 0), 0);
}

function canonicalSeriesNotificationUrl({ seriesKey = '', sourceUrl = '', representativeBook = null } = {}) {
  const asin =
    extractAsin(sourceUrl) || String(seriesKey || '').match(/^series:asin:([A-Z0-9]{10})$/i)?.[1] || '';
  if (asin) return amazonUrlForAsin(asin.toUpperCase());
  return sourceUrl || representativeBook?.amazonUrl || '';
}

function detectSeriesEvents({ before, after, settings }) {
  if (!before || !after || after.currentEffectiveTotal == null) return [];
  if (after.bookCount === 0 || after.pricedCount !== after.bookCount) return [];
  if (after.requiresFreshCheck && after.freshCheckedCount !== after.bookCount) return [];
  if (!after.currentTotalObserved) return [];

  const events = [];
  const previousObservedEffectiveTotal = before.latestObservedEffectiveTotal;
  const eventBase = {
    scope: 'series',
    notificationKey: after.key,
    notificationBookId: after.representativeBook?.id || before.representativeBook?.id || '',
    asin: extractAsin(after.url) || after.representativeBook?.asin || before.representativeBook?.asin || '',
    seriesKey: after.seriesKey,
    seriesName: after.seriesName,
    seriesUrl: after.url,
    bookCount: after.bookCount,
    effectivePrice: after.currentEffectiveTotal,
    notificationBook: seriesNotificationBook(after)
  };

  if (
    settings.notifyOnBestEver &&
    before.lowestEffectiveTotal != null &&
    after.currentEffectiveTotal < before.lowestEffectiveTotal
  ) {
    events.push({
      ...eventBase,
      type: 'best_ever',
      previousEffectivePrice: previousObservedEffectiveTotal,
      previousLowestEffectivePrice: before.lowestEffectiveTotal,
      dropPercent: percentDrop(before.lowestEffectiveTotal, after.currentEffectiveTotal)
    });
  }

  if (
    settings.notifyOnPriceDrop &&
    previousObservedEffectiveTotal != null &&
    after.currentEffectiveTotal < previousObservedEffectiveTotal
  ) {
    const dropPercent = percentDrop(previousObservedEffectiveTotal, after.currentEffectiveTotal);
    if (dropPercent >= settings.notificationThreshold) {
      events.push({
        ...eventBase,
        type: 'price_drop',
        previousEffectivePrice: previousObservedEffectiveTotal,
        dropPercent
      });
    }
  }

  return events;
}

function seriesNotificationBook(snapshot) {
  const representative = snapshot.representativeBook || {};
  return {
    ...representative,
    title: snapshot.seriesName || representative.seriesName || representative.title || 'Kindle シリーズ',
    amazonUrl: snapshot.url || representative.amazonUrl || '',
    currentPrice: snapshot.currentPriceTotal ?? snapshot.currentEffectiveTotal,
    currentPoints: snapshot.currentPriceTotal != null ? snapshot.currentPointsTotal || 0 : 0,
    effectivePrice: snapshot.currentEffectiveTotal,
    lowestEffectivePrice: snapshot.lowestEffectiveTotal,
    provider: 'series_total',
    notificationScope: 'series',
    asin: extractAsin(snapshot.url) || representative.asin || '',
    seriesKey: snapshot.seriesKey,
    seriesName: snapshot.seriesName,
    bookCount: snapshot.bookCount,
    pricedCount: snapshot.pricedCount
  };
}

function detectEvents({ book, previousEffectivePrice, previousLowestEffectivePrice, settings }) {
  const events = [];
  const current = book.effectivePrice;
  if (current == null) return events;

  if (
    settings.notifyOnBestEver &&
    previousLowestEffectivePrice != null &&
    current < previousLowestEffectivePrice
  ) {
    events.push({
      type: 'best_ever',
      effectivePrice: current,
      previousEffectivePrice,
      previousLowestEffectivePrice,
      dropPercent: percentDrop(previousLowestEffectivePrice, current)
    });
  }

  if (settings.notifyOnPriceDrop && previousEffectivePrice != null && current < previousEffectivePrice) {
    const dropPercent = percentDrop(previousEffectivePrice, current);
    if (dropPercent >= settings.notificationThreshold) {
      events.push({
        type: 'price_drop',
        effectivePrice: current,
        previousEffectivePrice,
        dropPercent
      });
    }
  }

  return events;
}

function alreadyNotified(store, bookId, event) {
  return store.notifications.some(
    (notification) =>
      notification.bookId === bookId &&
      notification.type === event.type &&
      notification.effectivePrice === event.effectivePrice &&
      notification.status === 'sent'
  );
}

function alreadyNotifiedSeries(store, event) {
  return store.notifications.some(
    (notification) =>
      notification.scope === 'series' &&
      notification.notificationKey === event.notificationKey &&
      notification.type === event.type &&
      notification.effectivePrice === event.effectivePrice &&
      notification.status === 'sent'
  );
}

async function markNotification(bookId, event, status, error = '') {
  await updateStore((store) => {
    markNotificationInStore(store, bookId, event, status, error);
    return store;
  });
}

function markNotificationInStore(store, bookId, event, status, error = '') {
  const notification = [...store.notifications]
    .reverse()
    .find(
      (item) =>
        notificationMatchesEvent(item, bookId, event) &&
        item.status === 'pending'
    );

  if (notification) {
    notification.status = status;
    notification.error = error;
    notification.sentAt = new Date().toISOString();
  }
}

function notificationMatchesEvent(item, bookId, event) {
  if (
    !(
        item.type === event.type &&
        item.effectivePrice === event.effectivePrice &&
        item.status === 'pending'
    )
  ) {
    return false;
  }

  if (event.scope === 'series') {
    return item.scope === 'series' && item.notificationKey === event.notificationKey;
  }

  return item.bookId === bookId;
}

function planDueChecks(store, settings, now, options = {}) {
  const rotatedBooks = rotateAfterCursor(store.books, store.checkCursor?.lastBookId);
  const priorityContext = checkPriorityContext(rotatedBooks, now, settings);
  if (options.forceAll) {
    const selected = orderCheckCandidates(rotatedBooks, priorityContext, now).slice(0, settings.batchSize);
    return { books: selected, dueSelected: selected.length };
  }

  const dueBefore = scheduledDueCutoffMs(now, settings);
  const dueBooks = rotatedBooks.filter((book) => isAutoCheckCandidate(book, dueBefore) && !isCheckRetryCoolingDown(book, now));
  const orderedDueBooks = orderCheckCandidates(dueBooks, priorityContext, now);
  const selected = selectCheckCandidatesWithSeriesCompletion(orderedDueBooks, rotatedBooks, priorityContext, now, settings.batchSize);
  const dueSelected = selected.filter((book) => isBookDue(book, dueBefore)).length;

  if (dueBooks.length > 0 && selected.length < settings.batchSize) {
    const selectedIds = new Set(selected.map((book) => book.id));
    const fillerBooks = orderCheckCandidates(
      rotatedBooks.filter((book) => !isCheckRetryCoolingDown(book, now)),
      priorityContext,
      now
    );
    for (const book of fillerBooks) {
      if (selected.length >= settings.batchSize) break;
      if (selectedIds.has(book.id) || isAutoCheckCandidate(book, dueBefore)) continue;
      selected.push(book);
      selectedIds.add(book.id);
    }
  }

  return { books: selected, dueSelected };
}

function selectCheckCandidatesWithSeriesCompletion(orderedBooks, allBooks, context, now, limit) {
  const selected = [];
  const selectedIds = new Set();

  for (const book of orderedBooks) {
    if (selected.length >= limit) break;
    if (selectedIds.has(book.id)) continue;

    selected.push(book);
    selectedIds.add(book.id);

    const completionBooks = seriesCompletionBooksForPlan(book, allBooks, context, now, selectedIds);
    if (completionBooks.length === 0 || completionBooks.length > limit - selected.length) continue;

    for (const completionBook of completionBooks) {
      selected.push(completionBook);
      selectedIds.add(completionBook.id);
    }
  }

  return selected;
}

function seriesCompletionBooksForPlan(book, allBooks, context, now, selectedIds) {
  const scope = notificationSeriesScope(book);
  if (!scope) return [];
  const group = context.series.get(scope.key);
  if (!group || group.aggregateMissing <= 0) return [];

  const candidates = allBooks.filter((candidate) => {
    if (selectedIds.has(candidate.id)) return false;
    const candidateScope = notificationSeriesScope(candidate);
    if (!candidateScope || candidateScope.key !== scope.key) return false;
    if (isCheckRetryCoolingDown(candidate, now)) return false;
    return needsSeriesAggregateRefresh(candidate, context.seriesFreshAfterMs);
  });

  return orderCheckCandidates(candidates, context, now);
}

function checkPriorityContext(books, now, settings = {}) {
  const series = new Map();
  const rotatedIndex = new Map();
  const seriesFreshAfterMs = seriesAggregateFreshAfter(now, settings).getTime();

  for (const [index, book] of books.entries()) {
    rotatedIndex.set(book.id, index);
    const scope = notificationSeriesScope(book);
    if (!scope) continue;

    const key = scope.key;
    if (!series.has(key)) {
      series.set(key, {
        total: 0,
        priced: 0,
        unpriced: 0,
        stale: 0,
        aggregateMissing: 0
      });
    }
    const group = series.get(key);
    group.total += 1;
    if (hasTrustedCurrentPrice(book)) {
      group.priced += 1;
    } else {
      group.unpriced += 1;
    }
    if (isBookStaleForPriority(book, now)) group.stale += 1;
    if (needsSeriesAggregateRefresh(book, seriesFreshAfterMs)) group.aggregateMissing += 1;
  }

  return { series, rotatedIndex, seriesFreshAfterMs };
}

function orderCheckCandidates(books, context, now) {
  return [...books].sort((left, right) => {
    const scoreDiff = checkPriorityScore(right, context, now) - checkPriorityScore(left, context, now);
    if (scoreDiff !== 0) return scoreDiff;
    return (context.rotatedIndex.get(left.id) ?? 0) - (context.rotatedIndex.get(right.id) ?? 0);
  });
}

function checkPriorityScore(book, context, now) {
  let score = 0;
  if (!hasTrustedCurrentPrice(book)) score += 100000;
  if (needsBookImageRefresh(book)) score += 60000;
  if (isDiscardedUnvalidatedSeriesPrice(book)) score += 25000;
  if (!book.lastCheckedAt) score += 12000;
  if (isBookStaleForPriority(book, now)) score += 2500;
  if (isTransientSnapshotError(book.lastError) && !isBlockingSnapshotError(book.lastError)) score += 1500;

  const scope = notificationSeriesScope(book);
  const series = scope ? context.series.get(scope.key) : null;
  if (series?.unpriced > 0) score += 10000 + Math.min(series.unpriced, 1000);
  if (series?.stale > 0) score += 1000 + Math.min(series.stale, 500);
  if (series?.aggregateMissing > 0) {
    if (needsSeriesAggregateRefresh(book, context.seriesFreshAfterMs)) score += 8000;
    score += Math.max(0, 3000 - series.aggregateMissing * 30);
  }

  if (isBlockingSnapshotError(book.lastError)) score -= 5000;
  return score;
}

function isAutoCheckCandidate(book, dueBefore) {
  return isBookDue(book, dueBefore) || needsBookImageRefresh(book);
}

function needsBookImageRefresh(book) {
  if (hasBookImage(book)) return false;
  if (isPermanentSnapshotError(book?.lastError)) return false;
  return true;
}

function hasBookImage(book) {
  return Boolean(book?.imageUrl || book?.imageKey);
}

function needsSeriesAggregateRefresh(book, freshAfterMs) {
  if (!hasTrustedCurrentPrice(book)) return true;
  const checkedAt = timestampMs(book.lastCheckedAt);
  return checkedAt <= 0 || checkedAt < freshAfterMs;
}

function hasTrustedCurrentPrice(book) {
  return (
    book?.currentPrice != null &&
    book?.effectivePrice != null &&
    !isUnvalidatedSeriesPriceProvider(book.provider) &&
    !isUnverifiedFreeSeriesPriceProvider(book.provider, book.currentPrice)
  );
}

function isDiscardedUnvalidatedSeriesPrice(book) {
  return String(book?.lastError || '').includes('未検証のシリーズ価格を破棄しました');
}

function isBookStaleForPriority(book, now) {
  const checkedAt = new Date(book?.lastCheckedAt || 0).getTime();
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return true;
  return now - checkedAt >= 3 * 24 * 60 * 60 * 1000;
}

function isCheckRetryCoolingDown(book, now) {
  if (!isTransientSnapshotError(book?.lastError) && !isBlockingSnapshotError(book?.lastError)) return false;
  if (isDiscardedUnvalidatedSeriesPrice(book)) return false;

  const checkedAt = new Date(book.lastCheckedAt || book.updatedAt || book.createdAt || 0).getTime();
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return false;
  return now - checkedAt < checkRetryCooldownMs(book);
}

function checkRetryCooldownMs(book) {
  const fallbackHours = isBlockingSnapshotError(book?.lastError) ? 12 : 3;
  return floorNumber(process.env.CHECK_RETRY_COOLDOWN_HOURS, 0, fallbackHours) * 60 * 60 * 1000;
}

function rotateAfterCursor(books, lastBookId = '') {
  if (!Array.isArray(books) || books.length === 0) return [];
  const cursorIndex = books.findIndex((book) => book.id === lastBookId);
  if (cursorIndex === -1 || cursorIndex === books.length - 1) return [...books];
  return [...books.slice(cursorIndex + 1), ...books.slice(0, cursorIndex + 1)];
}

function countDueBooks(books, now, settings) {
  const dueBefore = scheduledDueCutoffMs(now, settings);
  return books.filter((book) => isBookDue(book, dueBefore)).length;
}

function isBookDue(book, dueBefore) {
  if (!book.lastCheckedAt) return true;
  const checkedAt = new Date(book.lastCheckedAt).getTime();
  return !Number.isFinite(checkedAt) || checkedAt <= dueBefore;
}

function scheduledDueCutoffMs(now, settings = {}) {
  return latestJstExecutionBoundaryMs(now, settings);
}

function shouldWaitForScheduledExecutionWindow(source, options = {}, now = Date.now(), settings = {}) {
  if (options.ignoreExecutionWindow === true) return false;
  if (source !== 'cron' && source !== 'scheduler') return false;
  const firstBoundary = todayJstExecutionBoundaryMs(now, scheduledExecutionTimes(settings)[0]);
  if (now < firstBoundary) return true;

  const latestBoundary = latestJstExecutionBoundaryMs(now, settings);
  return now - latestBoundary > scheduledExecutionGraceMs();
}

function latestJstExecutionBoundaryMs(now, settings = {}) {
  const todayBoundaries = scheduledExecutionTimes(settings).map((time) => todayJstExecutionBoundaryMs(now, time));
  const latestToday = [...todayBoundaries].reverse().find((boundary) => now >= boundary);
  if (latestToday != null) return latestToday;
  return todayBoundaries[todayBoundaries.length - 1] - 24 * 60 * 60 * 1000;
}

function nextJstExecutionBoundaryMs(now, settings = {}) {
  const todayBoundaries = scheduledExecutionTimes(settings).map((time) => todayJstExecutionBoundaryMs(now, time));
  return todayBoundaries.find((boundary) => now < boundary) || todayBoundaries[0] + 24 * 60 * 60 * 1000;
}

function todayJstExecutionBoundaryMs(now, time) {
  const dayMs = 24 * 60 * 60 * 1000;
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  const jstDayStartUtc = Math.floor((Number(now) + jstOffsetMs) / dayMs) * dayMs - jstOffsetMs;
  return jstDayStartUtc + time.hour * 60 * 60 * 1000 + time.minute * 60 * 1000;
}

function scheduledExecutionTimes(settings = {}) {
  return [
    { hour: 3, minute: 54 },
    { hour: 15, minute: 54 }
  ];
}

function scheduledExecutionGraceMs() {
  return floorNumber(process.env.CHECK_EXECUTION_GRACE_MINUTES, 1, 180) * 60 * 1000;
}

function backupCronSkipState(automation = {}, now = Date.now(), settings = {}) {
  const executionBoundaryMs = latestJstExecutionBoundaryMs(now, settings);
  const lastFinishedMs = timestampMs(automation?.lastCronFinishedAt);
  const lastCronError = String(automation?.lastCronError || '').trim();
  const lastCronStoppedByRuntimeLimit = Boolean(automation?.lastCronStoppedByRuntimeLimit);
  const hasSameWindowCompletion = lastFinishedMs >= executionBoundaryMs;
  const hasSuccessfulCompletion = hasSameWindowCompletion && !lastCronError;
  const hasSavedRuntimeLimitCompletion =
    hasSameWindowCompletion && lastCronStoppedByRuntimeLimit && !lastCronError;
  const shouldSkip = hasSuccessfulCompletion || hasSavedRuntimeLimitCompletion;

  return {
    shouldSkip,
    skipDetail: hasSavedRuntimeLimitCompletion ? 'saved_runtime_limit' : hasSuccessfulCompletion ? 'successful_completion' : '',
    executionBoundaryAt: new Date(executionBoundaryMs).toISOString(),
    lastCronStartedAt: automation?.lastCronStartedAt || '',
    lastCronFinishedAt: automation?.lastCronFinishedAt || '',
    lastCronStoppedByRuntimeLimit,
    lastCronError
  };
}

function timestampMs(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function shouldStopForRuntimeLimit(startedAt, maxRuntimeMs, _completedCount = 0, reserveMs = 0) {
  return maxRuntimeMs > 0 && remainingRuntimeMs(startedAt, maxRuntimeMs, reserveMs) <= 0;
}

function readEnvBoolean(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function checkPacing() {
  return {
    delayMs: floorNumber(process.env.CHECK_REQUEST_DELAY_MS, 0, 1800),
    jitterMs: floorNumber(process.env.CHECK_REQUEST_JITTER_MS, 0, 1200),
    blockCooldownMs: floorNumber(process.env.CHECK_BLOCK_COOLDOWN_MS, 0, 60000)
  };
}

function seriesDiscoveryPacing() {
  return {
    delayMs: floorNumber(process.env.SERIES_DISCOVERY_DELAY_MS ?? process.env.CHECK_REQUEST_DELAY_MS, 0, 2500),
    jitterMs: floorNumber(process.env.SERIES_DISCOVERY_JITTER_MS ?? process.env.CHECK_REQUEST_JITTER_MS, 0, 1500)
  };
}

async function waitBeforeCheck(pacing, completedCount, startedAt, maxRuntimeMs, reserveMs = 0) {
  if (completedCount === 0) return true;
  return sleepWithinRuntime(randomizedDelay(pacing.delayMs, pacing.jitterMs), startedAt, maxRuntimeMs, reserveMs);
}

async function waitAfterBlockedCheck(pacing, startedAt, maxRuntimeMs, reserveMs = 0) {
  return sleepWithinRuntime(
    randomizedDelay(pacing.blockCooldownMs, Math.floor(pacing.blockCooldownMs / 3)),
    startedAt,
    maxRuntimeMs,
    reserveMs
  );
}

async function waitBeforeSeriesDiscovery(pacing, completedCount, startedAt, maxRuntimeMs, reserveMs = 0) {
  if (completedCount === 0) return true;
  return sleepWithinRuntime(randomizedDelay(pacing.delayMs, pacing.jitterMs), startedAt, maxRuntimeMs, reserveMs);
}

async function sleepWithinRuntime(ms, startedAt, maxRuntimeMs, reserveMs = 0) {
  const delay = Math.max(0, Math.round(ms || 0));
  if (delay === 0) return true;

  if (maxRuntimeMs > 0) {
    const remaining = remainingRuntimeMs(startedAt, maxRuntimeMs, reserveMs);
    if (remaining <= delay + 1000) return false;
  }

  await sleep(delay);
  return true;
}

function runtimeSaveReserveMs() {
  return floorNumber(process.env.CHECK_SAVE_RESERVE_MS, 0, 120000);
}

function checkBookMaxRuntimeMs() {
  return floorNumber(process.env.CHECK_BOOK_MAX_RUNTIME_MS, 1000, 60000);
}

function importItemMaxRuntimeMs() {
  return floorNumber(process.env.CHECK_IMPORT_ITEM_MAX_RUNTIME_MS, 1000, 90000);
}

function remainingRuntimeMs(startedAt, maxRuntimeMs, reserveMs = 0) {
  return maxRuntimeMs - (Date.now() - startedAt) - Math.max(0, Math.round(reserveMs || 0));
}

function runtimeAbortOptions(startedAt, maxRuntimeMs, options = {}) {
  const windows = [];
  if (maxRuntimeMs > 0) windows.push(remainingRuntimeMs(startedAt, maxRuntimeMs, options.reserveMs));
  if (options.capMs > 0) windows.push(Math.round(options.capMs));
  if (windows.length === 0) return { signal: undefined, cleanup: () => {} };

  const timeoutMs = Math.max(0, Math.min(...windows));
  const controller = new AbortController();
  if (timeoutMs <= 0) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => {} };
  }

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId)
  };
}

function randomizedDelay(baseMs, jitterMs) {
  const base = Math.max(0, Math.round(baseMs || 0));
  const jitter = Math.max(0, Math.round(jitterMs || 0));
  return base + (jitter > 0 ? Math.floor(Math.random() * (jitter + 1)) : 0);
}

function isBlockingCheckResult(result) {
  const value = String(result?.error || result?.book?.lastError || '');
  return isBlockingSnapshotError(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms || 0))));
}

function updateCheckCursor(store, book, checkedAt) {
  store.checkCursor = {
    lastBookId: book.id,
    lastAsin: book.asin,
    lastTitle: book.title,
    checkedAt
  };
}

function resetCursorIfDeleted(store, deletedIds) {
  if (store.checkCursor?.lastBookId && deletedIds.has(store.checkCursor.lastBookId)) {
    store.checkCursor = emptyCheckCursor();
  }
}

function emptyCheckCursor() {
  return {
    lastBookId: '',
    lastAsin: '',
    lastTitle: '',
    checkedAt: ''
  };
}

export async function recordCronRun(fields) {
  await updateStore((store) => {
    store.automation = {
      ...(store.automation || {}),
      ...fields
    };
    return store;
  });
}

async function persistBulkCheckStore({ store, cronFields = null }) {
  const nextAutomation = {
    ...(store.automation || {}),
    ...(cronFields || {})
  };
  store.automation = nextAutomation;

  await updateStore((currentStore) => {
    return {
      ...store,
      settings: currentStore.settings,
      automation: {
        ...(currentStore.automation || {}),
        ...nextAutomation
      }
    };
  });
}

function shouldPersistCronRun(result = {}) {
  return Boolean(
    result.checked > 0 ||
      result.remainingDue > 0 ||
      result.stoppedByRuntimeLimit ||
      hasImportQueueWork(result.importQueue) ||
      hasSeriesDiscoveryWork(result.seriesDiscovery)
  );
}

function hasImportQueueWork(importQueue = null) {
  if (!importQueue) return false;
  return Boolean(
    importQueue.processed > 0 ||
      importQueue.imported > 0 ||
      importQueue.updatedDuplicates > 0 ||
      importQueue.stoppedByRuntimeLimit ||
      (Array.isArray(importQueue.errors) && importQueue.errors.length > 0)
  );
}

function hasSeriesDiscoveryWork(seriesDiscovery = null) {
  if (!seriesDiscovery) return false;
  return Boolean(
    seriesDiscovery.checked > 0 ||
    seriesDiscovery.added > 0 ||
    seriesDiscovery.completed > 0 ||
    seriesDiscovery.skippedNoRun > 0 ||
    seriesDiscovery.stoppedByRuntimeLimit ||
    (Array.isArray(seriesDiscovery.errors) && seriesDiscovery.errors.length > 0)
  );
}

function mergedRuntimeSettings(settings = {}) {
  const schedule = runtimeScheduleSettings(settings);
  return {
    notificationThreshold: clampNumber(settings.notificationThreshold, 0, 95, 10),
    checkRunsPerDay: schedule.checkRunsPerDay,
    checkIntervalHours: 24,
    checkExecutionHourJst: schedule.checkExecutionHourJst,
    checkExecutionMinuteJst: schedule.checkExecutionMinuteJst,
    secondCheckExecutionHourJst: schedule.secondCheckExecutionHourJst,
    secondCheckExecutionMinuteJst: schedule.secondCheckExecutionMinuteJst,
    batchSize: floorNumber(settings.batchSize, 1, 50),
    notifyOnPriceDrop: settings.notifyOnPriceDrop !== false,
    notifyOnBestEver: settings.notifyOnBestEver !== false
  };
}

function runtimeScheduleSettings(settings = {}) {
  return {
    checkRunsPerDay: 2,
    checkExecutionHourJst: 3,
    checkExecutionMinuteJst: 54,
    secondCheckExecutionHourJst: 15,
    secondCheckExecutionMinuteJst: 54
  };
}

function minNullable(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function percentDrop(previous, current) {
  if (!previous || previous <= 0) return null;
  return Math.round(((previous - current) / previous) * 100);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function floorNumber(value, min, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.round(number));
}

function normalizeCheckRunsPerDay(value, fallback = 2) {
  const number = Number(value);
  return number === 1 || number === 2 ? number : fallback;
}

function normalizeCheckIntervalHours(value, fallback = 24) {
  const allowed = [24, 48, 72];
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  return allowed.includes(rounded) ? rounded : fallback;
}

function normalizeCheckExecutionHourJst(value, fallback = 15) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  return rounded >= 0 && rounded <= 23 ? rounded : fallback;
}

function normalizeCheckExecutionMinuteJst(value, fallback = 54) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  return rounded >= 0 && rounded <= 59 ? rounded : fallback;
}

function sortBooks(a, b) {
  const aCheckedAt = checkedSortTime(a);
  const bCheckedAt = checkedSortTime(b);
  if (aCheckedAt == null && bCheckedAt != null) return -1;
  if (aCheckedAt != null && bCheckedAt == null) return 1;
  if (aCheckedAt != null && bCheckedAt != null && aCheckedAt !== bCheckedAt) {
    return aCheckedAt - bCheckedAt;
  }
  const aTime = registrationSortTime(a);
  const bTime = registrationSortTime(b);
  if (aTime !== bTime) return aTime - bTime;
  return 0;
}

function checkedSortTime(book) {
  const time = new Date(book.lastCheckedAt || 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : null;
}

function registrationSortTime(book) {
  const time = new Date(book.createdAt || book.updatedAt || book.lastCheckedAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}
