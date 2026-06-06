import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
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
  cleanAmazonSeriesName,
  isProbablyBookAsin,
  isKindleSeriesUrl
} from './price-provider.mjs';
import {
  hasBlobConfig,
  publicBook,
  readStore,
  readStoreWithMetadata,
  registerStoreWriteListener,
  updateStore,
  writeBlobBookListPayload
} from './store.mjs';
import { bookListPayload } from './book-list-payload.mjs';
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
const AMAZON_HTML_TINY_PRICE_MAX = 10;
const DISCOUNT_RECHECK_DEFAULT_HOURS = 24;
const DISCOUNT_RECHECK_RATIO = 0.7;
const PRICE_INTEGRITY_SERIES_OUTLIER_RATIO = 0.55;
const LIST_PRICE_CHALLENGE_MAX_PER_SERIES = 2;
const LIST_PRICE_CHALLENGE_SAMPLE_LIMIT = 10;
const OBSERVED_LIST_PRICE_PROVIDER = 'observed_price_history';
const OBSERVED_PEER_LIST_PRICE_PROVIDER = 'observed_peer_price';
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_SERIES_EXPECTED_COUNT_OVERRIDES = new Map([
  ['series:asin:B00E5V5JMY', 3], // Wet Moon
  ['series:asin:B01IEGD30K', 3], // 青い空を、白い雲がかけてった
  ['series:asin:B07L2MX9LT', 18], // 東島丹三郎は仮面ライダーになりたい
  ['series:asin:B08R6X9DD5', 3], // サーチアンドデストロイ
  ['series:asin:B082WZ2KT2', 2], // セキララ結婚生活 / ７年目のセキララ結婚生活
  ['series:asin:B0C6JS577Q', 4] // SPUNK - スパンク！
]);
const STORED_SERIES_BOOK_FIXUPS = new Map([
  ['B082WZ2KT2', { volume: 2 }]
]);
const AUTHORITATIVE_MIXED_EDITION_SERIES_KEYS = new Set([
  'series:asin:B074CG522D' // 軍鶏: child-list order is the canonical current Kindle lineup.
]);
const MIXED_EDITION_SERIES_ASINS = new Set([
  'B00QAEZKNC',
  'B00QAEZKZU',
  'B00QAEZLDQ',
  'B00QAEZLAY',
  'B00RDYOB5Q',
  'B00RDYOBCE',
  'B00RDYOFHK'
]);

export async function listBooks() {
  const { store } = await readStoreWithPriceRepairsWithMetadata();
  return publicBooksFromStore(store);
}

export async function listBooksWithStoreMetadata() {
  const { store, etag } = await readStoreWithPriceRepairsWithMetadata();
  return {
    books: publicBooksFromStore(store),
    storeEtag: etag || ''
  };
}

export function publicBooksFromStore(store) {
  const seriesHistory = seriesHistorySummaries(store);
  const discountReferences = observedDiscountReferenceSummaries(store);
  return store.books
    .map((book) => publicBookWithSeriesHistory(book, seriesHistory, discountReferences))
    .sort(sortBooks);
}

registerStoreWriteListener(async (store, metadata = {}) => {
  if (!hasBlobConfig() || !metadata.etag) return;
  const body = Buffer.from(JSON.stringify(bookListPayload(publicBooksFromStore(store))));
  await writeBlobBookListPayload(metadata.etag, gzipSync(body));
});

async function readStoreWithPriceRepairs(options = {}) {
  const { store } = await readStoreWithPriceRepairsWithMetadata(options);
  return store;
}

async function readStoreWithPriceRepairsWithMetadata(options = {}) {
  const now = options.now || new Date().toISOString();
  const metadata = await readStoreWithMetadata();
  const repair = repairStorePriceState(metadata.store, { ...options, now });
  if (!repair.changed) return metadata;

  await updateStore((currentStore) => {
    repairStorePriceState(currentStore, { ...options, now });
    return currentStore;
  });
  return readStoreWithMetadata();
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
      now: options.now,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      seriesCandidateCache: options.seriesCandidateCache
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
    ? await fetchSeriesCandidates(input, {
        allowIncomplete: true,
        now: options.now,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        seriesCandidateCache: options.seriesCandidateCache
      })
    : await detectCollectionSeries(input, options);
  const asins = series?.items?.map((item) => item.asin) || [];

  if (!series || asins.length === 0) {
    const error = new Error('シリーズ内のKindle ASINを取得できませんでした');
    error.status = 422;
    throw error;
  }

  const mismatchReason = seriesDiscoveryResultMismatchReason(options.expectedSeriesName, series);
  if (mismatchReason) {
    const error = new Error(mismatchReason);
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
  const sourceUrl = canonicalSingleBookSourceUrl(asin, input);
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
  const sourceAsin = canonicalSeriesSourceAsin(input, series);
  const seriesKey = seriesKeyForSeries(input, series);
  const seriesName = cleanStoredSeriesName(series.seriesName || 'Kindle シリーズ');
  const sourceUrl = seriesSourceUrlFor(input, series);
  const seriesCompleted = Boolean(series.completed);
  const seriesIdentity = {
    input,
    sourceUrl,
    sourceAsin,
    seriesKey,
    seriesName
  };

  const sourceIsSeriesItem = Boolean(sourceAsin && series.items.some((item) => item.asin === sourceAsin));
  const obsoleteIds = new Set(
    store.books
      .filter(
        (book) =>
          sourceAsin &&
          book.asin === sourceAsin &&
          !sourceIsSeriesItem &&
          (isKnownBookForSeries(book, seriesIdentity) ||
            isSameSeriesSource(book.sourceUrl, sourceUrl, sourceAsin) ||
            !book.seriesKey)
      )
      .map((book) => book.id)
  );
  if (obsoleteIds.size > 0) {
    removeStoreBooksById(store, obsoleteIds);
  }

  const mergedSeriesItems = mergeWithKnownSeriesItems(series.items, store.books, seriesIdentity);
  const seriesItems = [];
  let skippedSeriesNavigationItems = 0;
  for (const item of mergedSeriesItems) {
    if (isNonBookSeriesCandidateItem(item)) {
      skippedSeriesNavigationItems += 1;
      seriesErrors.push(`${item.asin}: skipped non-book series candidate (${item.title})`);
      continue;
    }
    if (isClearlyDifferentSeriesTitle(item.title, seriesName)) {
      seriesErrors.push(`${item.asin}: skipped title outside series (${item.title})`);
      continue;
    }
    if (isSupplementalSeriesBookTitle(item.title, seriesName)) {
      seriesErrors.push(`${item.asin}: skipped supplemental series book (${item.title})`);
      continue;
    }
    if (isLikelySeriesContainerCandidateItem(item, seriesIdentity, mergedSeriesItems, seriesName)) {
      seriesErrors.push(`${item.asin}: skipped source container series book (${item.title})`);
      continue;
    }
    seriesItems.push(item);
  }
  let regularSeriesItems = dropDuplicateAlternativeEditionItems(seriesItems, seriesErrors);
  regularSeriesItems = dropDuplicateAmbiguousSeriesItems(regularSeriesItems, seriesName, seriesErrors);
  regularSeriesItems = await dropFutureReleaseNewSeriesItems(regularSeriesItems, store, seriesErrors, {
    now,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    ...seriesIdentity
  });

  if (isSingleBookSeriesCandidate(series, regularSeriesItems)) {
    return importSingleBookSeriesCandidateIntoStore(store, input, regularSeriesItems[0], {
      ...options,
      now,
      sourceUrl
    });
  }

  const currentSeriesAsins = new Set(regularSeriesItems.map((item) => item.asin).filter(Boolean));
  const currentListIsAuthoritative = isAuthoritativeMixedEditionCurrentList(
    seriesIdentity,
    series,
    regularSeriesItems
  );
  const obsoleteEpisodeIds = new Set(
    store.books
      .filter((book) => isKnownBookForSeries(book, seriesIdentity))
      .filter(
        (book) =>
          (currentListIsAuthoritative && !currentSeriesAsins.has(book.asin)) ||
          isLikelyObsoleteSeriesContainerBook(book, currentSeriesAsins, regularSeriesItems, seriesName) ||
          isLikelyObsoleteSingleEpisodeSeriesBook(book, currentSeriesAsins, seriesName) ||
          isLikelyObsoleteAlternativeEditionSeriesBook(book, currentSeriesAsins, regularSeriesItems, seriesName)
      )
      .map((book) => book.id)
  );
  if (obsoleteEpisodeIds.size > 0) {
    removeStoreBooksById(store, obsoleteEpisodeIds);
  }

  const existingByAsin = new Map(store.books.map((book) => [book.asin, book]));
  const expectedSeries =
    skippedSeriesNavigationItems === 0 && regularSeriesItems.length === seriesItems.length
      ? series
      : { ...series, expectedVolumeCount: currentExpectedVolumeCount(regularSeriesItems) };
  const seriesExpectedCount = normalizeSeriesExpectedCount(expectedSeries, regularSeriesItems);
  const existingSeriesBooks = store.books.filter((book) => isKnownBookForSeries(book, seriesIdentity));
  await backfillKnownWeakSeriesImages(regularSeriesItems, existingSeriesBooks, seriesErrors, {
    now,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
  const weakImageUrls = weakSeriesImageUrls([...regularSeriesItems, ...existingSeriesBooks]);
  const additions = [];

  for (const [index, item] of regularSeriesItems.entries()) {
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
    if (isSupplementalSeriesBookTitle(book.title, seriesName)) {
      seriesErrors.push(`${asin}: skipped supplemental series book (${book.title})`);
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

function dropDuplicateAlternativeEditionItems(items = [], errors = []) {
  const byVolume = new Map();
  for (const item of items) {
    const volume = seriesItemVolume(item);
    if (!volume) continue;
    const group = byVolume.get(volume) || [];
    group.push(item);
    byVolume.set(volume, group);
  }

  const droppedAsins = new Set();
  for (const [volume, group] of byVolume.entries()) {
    if (group.length <= 1) continue;
    const ranks = group.map(alternativeEditionRank);
    const minRank = Math.min(...ranks);
    if (minRank > 0 || !group.some(isAlternativeEditionSeriesItem)) continue;

    const keep = group.filter((item) => alternativeEditionRank(item) === minRank).sort(compareSeriesEditionPreference)[0];
    for (const item of group) {
      if (item.asin === keep.asin) continue;
      if (alternativeEditionRank(item) === minRank) continue;
      droppedAsins.add(item.asin);
      errors.push(`${item.asin}: skipped duplicate volume ${volume} alternative edition (${item.title})`);
    }
  }

  if (droppedAsins.size === 0) return items;
  return items.filter((item) => !droppedAsins.has(item.asin));
}

function dropDuplicateAmbiguousSeriesItems(items = [], seriesName = '', errors = []) {
  const byVolume = new Map();
  for (const item of items) {
    const volume = seriesItemVolume(item);
    if (!volume) continue;
    const group = byVolume.get(volume) || [];
    group.push(item);
    byVolume.set(volume, group);
  }

  const droppedAsins = new Set();
  for (const [volume, group] of byVolume.entries()) {
    if (group.length <= 1) continue;
    const keep = preferredSeriesDuplicateItem(group, seriesName, volume);
    if (!keep || !shouldDropAmbiguousSeriesDuplicateGroup(group, keep, seriesName, volume)) continue;

    for (const item of group) {
      if (item.asin === keep.asin) continue;
      if (!isDroppableAmbiguousSeriesDuplicate(item, keep, seriesName, volume)) continue;
      droppedAsins.add(item.asin);
      errors.push(`${item.asin}: skipped ambiguous duplicate volume ${volume} (${item.title})`);
    }
  }

  if (droppedAsins.size === 0) return items;
  return items.filter((item) => !droppedAsins.has(item.asin));
}

function shouldDropAmbiguousSeriesDuplicateGroup(group, keep, seriesName, volume) {
  if (!keep || group.length <= 1) return false;
  return group.some((item) => isDroppableAmbiguousSeriesDuplicate(item, keep, seriesName, volume));
}

function isDroppableAmbiguousSeriesDuplicate(item, keep, seriesName, volume) {
  if (!item?.asin || item.asin === keep?.asin) return false;
  if (isNonBookSeriesCandidateItem(item)) return true;
  if (isSupplementalSeriesBookTitle(item.title, seriesName || item.seriesName)) return true;
  if (alternativeEditionRank(item) > alternativeEditionRank(keep)) return true;

  const itemTitleVolume = trustedVolumeFromSeriesTitle(item.title, seriesName || item.seriesName);
  const keepTitleVolume = trustedVolumeFromSeriesTitle(keep.title, seriesName || keep.seriesName);
  if (keepTitleVolume === volume && itemTitleVolume !== volume) return true;
  return false;
}

function preferredSeriesDuplicateItem(group, seriesName, volume) {
  return [...group].sort((left, right) => {
    const leftTitleVolume = trustedVolumeFromSeriesTitle(left.title, seriesName || left.seriesName) === volume ? 1 : 0;
    const rightTitleVolume = trustedVolumeFromSeriesTitle(right.title, seriesName || right.seriesName) === volume ? 1 : 0;
    if (leftTitleVolume !== rightTitleVolume) return rightTitleVolume - leftTitleVolume;

    const leftNonBook = isNonBookSeriesCandidateItem(left) ? 1 : 0;
    const rightNonBook = isNonBookSeriesCandidateItem(right) ? 1 : 0;
    if (leftNonBook !== rightNonBook) return leftNonBook - rightNonBook;

    const editionRank = alternativeEditionRank(left) - alternativeEditionRank(right);
    if (editionRank !== 0) return editionRank;

    return compareSeriesEditionPreference(left, right);
  })[0] || null;
}

function compareSeriesEditionPreference(left, right) {
  const editionRank = alternativeEditionRank(left) - alternativeEditionRank(right);
  if (editionRank !== 0) return editionRank;

  const providerRank = seriesPriceProviderRank(right.provider) - seriesPriceProviderRank(left.provider);
  if (providerRank !== 0) return providerRank;

  const leftPrice = Number(left.currentPrice);
  const rightPrice = Number(right.currentPrice);
  if (Number.isFinite(leftPrice) && Number.isFinite(rightPrice) && leftPrice !== rightPrice) {
    return leftPrice - rightPrice;
  }

  return String(left.title || left.asin).localeCompare(String(right.title || right.asin), 'ja');
}

function isAlternativeEditionSeriesItem(item) {
  return alternativeEditionRank(item) > 0;
}

function alternativeEditionRank(item = {}) {
  if (isKnownMixedEditionSeriesItem(item)) return 0;
  const title = String(item.title || '');
  if (/特装版|限定版|特別版|豪華版|愛蔵版|完全版|新装版|小冊子|付録|同梱|カラー版|フルカラー|合本|単話|分冊/i.test(title)) {
    return 10;
  }
  return 0;
}

function isKnownMixedEditionSeriesItem(item = {}) {
  const asin = String(item.asin || '').toUpperCase();
  return Boolean(asin && MIXED_EDITION_SERIES_ASINS.has(asin));
}

async function dropFutureReleaseNewSeriesItems(items = [], store = {}, errors = [], options = {}) {
  const targets = futureReleaseValidationTargets(items, store);
  if (targets.length === 0) return items;

  const droppedAsins = new Set();
  const knownMaxVolume = Math.max(
    maxKnownSeriesVolume(store, options),
    maxConfirmedSeriesItemVolume(items, options.seriesName)
  );
  const targetAsins = new Set(targets.map((item) => item.asin).filter(Boolean));
  for (const item of targets) {
    try {
      const snapshot = await fetchAmazonHtmlSnapshotForSeriesBackfill(item.asin, item, options);
      if (isFutureReleaseDate(snapshot.releaseDate, options.now)) {
        droppedAsins.add(item.asin);
        errors.push(`${item.asin}: skipped future release (${snapshot.releaseDate})`);
        continue;
      }
      if (isSupplementalSeriesBookTitle(snapshot.title, options.seriesName)) {
        droppedAsins.add(item.asin);
        errors.push(`${item.asin}: skipped supplemental series book (${snapshot.title})`);
        continue;
      }
      if (isClearlyDifferentSeriesTitle(snapshot.title, options.seriesName)) {
        droppedAsins.add(item.asin);
        errors.push(`${item.asin}: skipped title outside series (${snapshot.title})`);
        continue;
      }
      Object.assign(item, mergeAmazonSnapshotIntoSeriesItem(item, snapshot));
      if (isUnvalidatedSyntheticTailSeriesItem(item, options.seriesName, knownMaxVolume)) {
        droppedAsins.add(item.asin);
        errors.push(`${item.asin}: deferred unvalidated tail candidate (${item.title})`);
        continue;
      }
    } catch (error) {
      if (isUnvalidatedSyntheticTailSeriesItem(item, options.seriesName, knownMaxVolume)) {
        droppedAsins.add(item.asin);
        errors.push(`${item.asin}: deferred unvalidated tail candidate (${error.message})`);
      }
    }
  }

  for (const item of items) {
    if (!item?.asin || targetAsins.has(item.asin) || droppedAsins.has(item.asin)) continue;
    if (!isUnvalidatedSyntheticTailSeriesItem(item, options.seriesName, knownMaxVolume)) continue;
    droppedAsins.add(item.asin);
    errors.push(`${item.asin}: deferred unvalidated tail candidate (validation limit)`);
  }

  if (droppedAsins.size === 0) return items;
  return items.filter((item) => !droppedAsins.has(item.asin));
}

function futureReleaseValidationTargets(items = [], store = {}) {
  const existingAsins = new Set((store.books || []).map((book) => book.asin).filter(Boolean));
  const limit = floorNumber(
    process.env.SERIES_NEW_ITEM_VALIDATION_LIMIT ?? process.env.SERIES_FUTURE_RELEASE_PROBE_LIMIT,
    1,
    5
  );
  return items
    .filter((item) => item?.asin && !existingAsins.has(item.asin))
    .sort((left, right) => {
      const volumeDiff = (seriesItemVolume(right) || 0) - (seriesItemVolume(left) || 0);
      if (volumeDiff !== 0) return volumeDiff;
      return String(right.asin || '').localeCompare(String(left.asin || ''));
    })
    .slice(0, limit);
}

function maxKnownSeriesVolume(store = {}, options = {}) {
  const volumes = (store.books || [])
    .filter((book) => isKnownBookForSeries(book, options))
    .map(storedBookVolume)
    .filter((volume) => Number.isFinite(volume) && volume > 0);
  return volumes.length ? Math.max(...volumes) : 0;
}

function maxConfirmedSeriesItemVolume(items = [], seriesName = '') {
  const volumes = items
    .map((item) => confirmedSeriesItemVolume(item, seriesName))
    .filter((volume) => Number.isFinite(volume) && volume > 0);
  return volumes.length ? Math.max(...volumes) : 0;
}

function confirmedSeriesItemVolume(item = {}, seriesName = '') {
  if (!item?.asin || isUnresolvedAsinPlaceholderTitle(item.title, item.asin)) return 0;
  if (isNonBookSeriesCandidateItem(item)) return 0;
  if (isSupplementalSeriesBookTitle(item.title, seriesName || item.seriesName)) return 0;
  if (isClearlyDifferentSeriesTitle(item.title, seriesName || item.seriesName)) return 0;
  return trustedVolumeFromSeriesTitle(item.title, seriesName || item.seriesName);
}

function isUnvalidatedSyntheticTailSeriesItem(item = {}, seriesName = '', knownMaxVolume = 0) {
  const volume = seriesItemVolume(item);
  if (!volume || volume <= knownMaxVolume || knownMaxVolume < 3) return false;
  if (!isUnvalidatedSyntheticTailTitle(item, seriesName, volume)) return false;
  if (isUnresolvedAsinPlaceholderTitle(item.title, item.asin) && nullableNumber(item.currentPrice) == null) return true;

  const provider = String(item.provider || '').toLowerCase();
  return (
    !provider ||
    provider === 'pending' ||
    provider === 'pending_series' ||
    provider === 'series_diff_pending' ||
    provider === 'amazon_series_bulk' ||
    provider === 'amazon_series_reader' ||
    isUnvalidatedSeriesPriceProvider(provider) ||
    item.imageSource === 'series_fallback'
  );
}

function isUnvalidatedSyntheticTailTitle(item = {}, seriesName = '', volume = 0) {
  return (
    isSyntheticSeriesVolumeTitle(item.title, seriesName, volume) ||
    isUnresolvedAsinPlaceholderTitle(item.title, item.asin)
  );
}

function isUnresolvedAsinPlaceholderTitle(title = '', asin = '') {
  const value = String(title || '').trim();
  const normalizedAsin = String(asin || '').trim().toUpperCase();
  if (!value) return true;
  const match = value.match(/^ASIN\s+([A-Z0-9]{10})$/i);
  return Boolean(match && (!normalizedAsin || match[1].toUpperCase() === normalizedAsin));
}

function isSyntheticSeriesVolumeTitle(title, seriesName, volume) {
  const titleStem = seriesTitleComparisonStem(title);
  const seriesStem = seriesTitleComparisonStem(seriesName);
  if (!titleStem || !seriesStem || !volume) return false;
  const fullWidth = toFullWidthNumber(volume);
  const variants = [
    `${seriesName} ${volume}`,
    `${seriesName} ${fullWidth}`,
    `${seriesName}${volume}`,
    `${seriesName}${fullWidth}`
  ].map(seriesTitleComparisonStem);
  return variants.includes(titleStem) || titleStem === `${seriesStem}${volume}` || titleStem === `${seriesStem}${fullWidth}`;
}

async function backfillKnownWeakSeriesImages(items = [], existingBooks = [], errors = [], options = {}) {
  if (!items.length || !existingBooks.length) return;

  const itemsByAsin = new Map(items.map((item) => [item.asin, item]));
  const initialWeakImageUrls = weakSeriesImageUrls([...items, ...existingBooks]);
  const targets = existingBooks
    .filter((book) => {
      if (!book?.asin) return false;
      const item = itemsByAsin.get(book.asin);
      if (!item) return false;
      if (!isWeakSeriesImage(seedFromExistingBook(book), initialWeakImageUrls)) return false;
      return isWeakSeriesImage(item, initialWeakImageUrls);
    })
    .sort((left, right) => compareSeriesItemSeeds(seedFromExistingBook(left), seedFromExistingBook(right)));

  if (targets.length === 0) return;

  const limit = floorNumber(process.env.SERIES_KNOWN_IMAGE_BACKFILL_LIMIT, 1, 24);
  const limitedTargets = targets.slice(0, limit);
  if (targets.length > limitedTargets.length) {
    errors.push(`series known image backfill limited: ${limitedTargets.length}/${targets.length} attempted`);
  }

  for (const book of limitedTargets) {
    const item = itemsByAsin.get(book.asin);
    if (!item) continue;

    try {
      const snapshot = await fetchAmazonHtmlSnapshotForSeriesBackfill(book.asin, item, options);
      if (!snapshot.imageUrl || isWeakSeriesImageUrl(snapshot.imageUrl)) {
        errors.push(`${book.asin}: image backfill did not find a usable cover`);
        continue;
      }
      Object.assign(item, mergeAmazonSnapshotIntoSeriesItem(item, snapshot));
    } catch (error) {
      errors.push(`${book.asin}: image backfill failed (${error.message})`);
    }
  }
}

async function importSingleBookSeriesCandidateIntoStore(store, input, item, options = {}) {
  const now = options.now || new Date().toISOString();
  const asin = item?.asin || extractAsin(input);
  if (!asin) {
    const error = new Error('Amazon URL または ASIN を入力してください');
    error.status = 400;
    throw error;
  }

  const sourceUrl = canonicalSingleBookSourceUrl(asin, options.sourceUrl || input || item?.amazonUrl);
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
  const sourceUrl = canonicalSingleBookSourceUrl(extractAsin(input), input);
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
      if (isPermanentSnapshotError(snapshotResult?.error) || isTrustedSeriesOverrideSnapshotError(snapshotResult?.error)) {
        book.lastCheckedAt = now;
        updated = true;
      } else if (isUnresolvedSingleBook(book) && book.lastCheckedAt) {
        book.lastCheckedAt = null;
        updated = true;
      }
      const repair = repairSuspiciousPriceState(book, store, {
        clearCurrent: true,
        restoreMissingCurrent: true,
        clearStaleDiscountedCurrent: isSuspiciousSnapshotError(snapshotResult?.error)
      });
      if (repair.changed) updated = true;
      if (isPermanentSnapshotError(snapshotResult?.error) || isTrustedSeriesOverrideSnapshotError(snapshotResult?.error)) {
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
    applyMergedSnapshotListPrice(book, snapshot);
    applySnapshotPriceEvidence(book, snapshot);
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
    const series = await fetchKindleSeriesCandidate(input, options);
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
    : await resolveSeriesCandidateDiffs(merged, usableCandidates, options);
  if (!isIncompleteSeriesCandidate(resolved)) return resolved;
  return options.allowIncomplete && isUsableIncompleteSeriesCandidate(resolved) ? resolved : null;
}

async function fetchKindleSeriesCandidate(input, options = {}) {
  const cache = options.seriesCandidateCache;
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') {
    return fetchKindleSeriesItems(input, options);
  }

  const key = seriesCandidateCacheKey(input, options);
  if (cache.has(key)) return cache.get(key);

  const promise = fetchKindleSeriesItems(input, options).then(
    (series) => {
      cache.set(key, series);
      return series;
    },
    (error) => {
      cache.delete(key);
      throw error;
    }
  );
  cache.set(key, promise);
  return promise;
}

function cachedKindleSeriesCandidate(input, options = {}) {
  const cache = options.seriesCandidateCache;
  if (!cache || typeof cache.get !== 'function') return null;

  const value = cache.get(seriesCandidateCacheKey(input, options));
  if (!value || typeof value.then === 'function') return null;
  return value;
}

function seriesCandidateCacheKey(input, options = {}) {
  return [
    options.requireCollectionPage ? 'collection' : 'series',
    String(input || '').trim()
  ].join(':');
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
    seriesName: cleanStoredSeriesName(base.seriesName || overlay.seriesName),
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
  } else if (Object.hasOwn(options, 'completed') && book.seriesCompleted) {
    book.seriesCompleted = false;
    book.seriesCompletedAt = '';
  }
}

function isIncompleteSeriesCandidate(series) {
  const items = Array.isArray(series?.items) ? series.items : [];
  const expected = Math.max(Number(series?.expectedVolumeCount) || 0, maxSeriesItemVolume(items), items.length);
  return seriesCompletenessErrors(items, expected).length > 0;
}

export function isUsableIncompleteSeriesCandidate(series) {
  const items = Array.isArray(series?.items) ? series.items : [];
  if (items.length <= 1) return false;

  const expected = Math.max(Number(series?.expectedVolumeCount) || 0, maxSeriesItemVolume(items), items.length);
  if (expected <= items.length) return true;

  const coverage = items.length / expected;
  const qualityCount = items.filter(hasUsableSeriesCandidateEvidence).length;
  const hasPrefix = hasContiguousSeriesPrefix(items, Math.min(3, items.length));
  const allUnresolved = items.every((item) => item.currentPrice == null && !item.imageUrl && isPlaceholderSeriesTitle(item.title));

  if (allUnresolved) return false;
  if (isLikelyCappedSeriesPageCandidate(items, expected)) return false;
  if (!hasPrefix && expected >= items.length + 5) return false;
  if (qualityCount < Math.min(2, items.length)) return false;
  if (coverage < 0.15 && expected >= 12) return false;
  return true;
}

function isLikelyCappedSeriesPageCandidate(items = [], expected = 0) {
  const count = items.length;
  if (expected <= count || count < 50) return false;
  return count % 50 === 0;
}

function hasUsableSeriesCandidateEvidence(item = {}) {
  if (item.currentPrice != null) return true;
  if (item.imageUrl) return true;
  if (!isPlaceholderSeriesTitle(item.title)) return true;
  return false;
}

function isPlaceholderSeriesTitle(value = '') {
  return /^ASIN\s+[A-Z0-9]{10}$/i.test(String(value || '').trim());
}

function hasContiguousSeriesPrefix(items = [], requiredLength = 1) {
  const required = Math.max(1, Number(requiredLength) || 1);
  const volumes = new Set(items.map(seriesItemVolume).filter((volume) => Number.isFinite(volume) && volume > 0));
  for (let volume = 1; volume <= required; volume += 1) {
    if (!volumes.has(volume)) return false;
  }
  return true;
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

async function resolveSeriesCandidateDiffs(series, candidates, options = {}) {
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
      const snapshot = await fetchAmazonHtmlSnapshotForSeriesBackfill(asin, item, options);
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

  const futureReleaseDrops = dropFutureReleaseItems(itemsByAsin, options);
  for (const item of futureReleaseDrops) {
    errors.push(`${item.asin}: skipped future release (${item.releaseDate})`);
  }

  return withSeriesReconciliation({
    ...series,
    expectedVolumeCount: futureReleaseDrops.length > 0 ? currentExpectedVolumeCount([...itemsByAsin.values()]) : series.expectedVolumeCount,
    items: [...itemsByAsin.values()]
  }, {
    diffAsins,
    enriched,
    errors
  });
}

function dropFutureReleaseItems(itemsByAsin, options = {}) {
  const dropped = [];
  for (const [asin, item] of itemsByAsin.entries()) {
    if (!isFutureReleaseDate(item?.releaseDate, options.now)) continue;
    dropped.push(item);
    itemsByAsin.delete(asin);
  }
  return dropped;
}

export function isFutureReleaseDate(value, now = new Date()) {
  const match = String(value || '').match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/);
  if (!match) return false;
  const releaseDay = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) return false;
  const jst = new Date(nowDate.getTime() + 9 * 60 * 60 * 1000);
  const today = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return releaseDay > today;
}

function currentExpectedVolumeCount(items = []) {
  return Math.max(maxSeriesItemVolume(items), items.length);
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
  if (isWeakSeriesImageUrl(item.imageUrl)) return true;
  return weakImageUrls.has(normalizeImageUrl(item.imageUrl));
}

function weakSeriesImageUrls(items = []) {
  const counts = new Map();
  for (const item of items) {
    const normalized = normalizeImageUrl(item?.imageUrl);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  return new Set(
    [...counts.entries()]
      .filter(([url, count]) => count > 1 || isWeakSeriesImageUrl(url))
      .map(([url]) => url)
  );
}

export function isWeakSeriesImageUrl(value) {
  const normalized = normalizeImageUrl(value).toLowerCase();
  return (
    Boolean(normalized) &&
    (/\/a19vjrnyppl\./.test(normalized) ||
      /(?:no[_-]?image|not[_-]?available|placeholder|transparent|pixel|sprite)/.test(normalized))
  );
}

async function fetchAmazonHtmlSnapshotForSeriesBackfill(asin, seed = {}, options = {}) {
  const attempts = floorNumber(process.env.SERIES_PRICE_BACKFILL_ATTEMPTS, 1, 2);
  let lastSnapshot = null;
  let lastError = null;

  for (const url of seriesBackfillUrls(asin)) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const snapshot = await fetchAmazonHtmlSnapshot(asin, url, {
          ...seed,
          signal: options.signal,
          timeoutMs: options.timeoutMs
        });
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
    releaseDate: snapshot.releaseDate || item.releaseDate || '',
    imageUrl: snapshot.imageUrl || item.imageUrl || '',
    imageSource: snapshot.imageUrl ? snapshot.provider || 'amazon_html' : item.imageSource || '',
    amazonUrl: snapshot.amazonUrl || item.amazonUrl || amazonUrlForAsin(item.asin),
    currentPrice,
    currentPoints: useSnapshotPrice ? snapshot.currentPoints ?? 0 : item.currentPoints ?? 0,
    effectivePrice: useSnapshotPrice ? snapshot.effectivePrice ?? effectivePriceFromSeed(snapshot) : item.effectivePrice,
    listPrice,
    provider,
    explicitPriceDisplay: useSnapshotPrice ? Boolean(snapshot.explicitPriceDisplay) : Boolean(item.explicitPriceDisplay),
    explicitFreeKindlePrice: useSnapshotPrice ? Boolean(snapshot.explicitFreeKindlePrice) : Boolean(item.explicitFreeKindlePrice),
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
    book.explicitPriceDisplay = Boolean(item.explicitPriceDisplay);
    book.explicitFreeKindlePrice = Boolean(item.explicitFreeKindlePrice);
    book.lowestPrice = book.lowestPrice == null ? item.currentPrice : Math.min(book.lowestPrice, item.currentPrice);
    if (effectivePrice != null) {
      book.lowestEffectivePrice =
        book.lowestEffectivePrice == null ? effectivePrice : Math.min(book.lowestEffectivePrice, effectivePrice);
    }
    if (shouldIgnoreListPriceForProvider(book.currentPrice, book.listPrice, listPriceProviderForBook(book))) {
      book.listPrice = null;
      book.listPriceProvider = '';
    }
    if (listPrice != null && book.listPrice == null) {
      book.listPrice = listPrice;
      book.listPriceProvider = provider;
    }
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
  const bookImageIsWeak = isWeakSeriesImageUrl(book.imageUrl) || weakImageUrls.has(normalizeImageUrl(book.imageUrl));
  const itemImageIsWeak =
    item.imageSource === 'series_fallback' ||
    isWeakSeriesImageUrl(item.imageUrl) ||
    weakImageUrls.has(normalizeImageUrl(item.imageUrl));
  if (bookImageIsWeak && !itemImageIsWeak) return true;
  if (seriesImageProviderRank(item.provider) > seriesImageProviderRank(book.provider)) return true;
  return book.provider === 'curated_series';
}

function shouldRefreshSeriesTitle(book, item) {
  if (!item.title) return false;
  if (isClearlyDifferentSeriesTitle(item.title, book.seriesName || item.seriesName)) return false;
  if (/^ASIN\s+[A-Z0-9]{10}$/i.test(book.title || '')) return true;
  if (isAmazonErrorPageBookTitle(book.title)) return true;
  if (shouldTrustStoredSeriesChildVolume(book) && book.title !== item.title && isTrustedMixedEditionItemTitle(book, item)) {
    return true;
  }

  const bookVolume = volumeFromSeriesTitle(book.title);
  const itemVolume = seriesItemVolume(item);
  if (bookVolume && itemVolume && bookVolume !== itemVolume) return true;

  return book.provider === 'curated_series' && item.provider && item.provider !== 'curated_series' && book.title !== item.title;
}

function isTrustedMixedEditionItemTitle(book, item) {
  const title = String(item?.title || '').trim();
  if (!title || /^ASIN\s+[A-Z0-9]{10}$/i.test(title)) return false;
  const seriesName = book.seriesName || item.seriesName || '';
  if (isKnownMixedEditionSeriesTitle(title, seriesName)) return true;

  const titleVolume = volumeFromSeriesTitle(title);
  const itemVolume = Number(item?.volume) || 0;
  return Boolean(titleVolume > 0 && itemVolume > 0 && titleVolume !== itemVolume);
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

export function suspiciousSnapshotReason(book, snapshot) {
  const seriesOverrideReason = untrustedAmazonHtmlSeriesOverrideReason(book, snapshot);
  if (seriesOverrideReason) return seriesOverrideReason;

  return suspiciousPriceReason({
    price: snapshot.currentPrice,
    points: snapshot.currentPoints,
    effectivePrice: snapshot.effectivePrice,
    listPrice: snapshotValidationListPrice(book, snapshot),
    provider: snapshot.provider,
    explicitPriceDisplay: snapshot.explicitPriceDisplay,
    explicitFreeKindlePrice: snapshot.explicitFreeKindlePrice,
    referencePrices: [
      book.currentPrice,
      book.effectivePrice,
      book.previousEffectivePrice,
      book.listPrice,
      snapshot.listPrice
    ]
  });
}

function untrustedAmazonHtmlSeriesOverrideReason(book = {}, snapshot = {}) {
  if (!hasTrustedSeriesPagePrice(book)) return '';
  if (String(snapshot.provider || '').toLowerCase() !== 'amazon_html') return '';
  if (snapshot.explicitPriceDisplay || snapshot.explicitFreeKindlePrice) return '';

  const current = Number(book.currentPrice);
  const next = Number(snapshot.currentPrice);
  if (!Number.isFinite(current) || current < 0 || !Number.isFinite(next) || next < 0) return '';
  if (current === next) return '';

  return 'シリーズ一括取得済み価格を、円表示の証拠が弱い単巻HTML価格で上書きしません';
}

function hasTrustedSeriesPagePrice(book = {}) {
  if (book.currentPrice == null) return false;
  return ['amazon_series_bulk', 'amazon_series_child'].includes(String(book.provider || '').toLowerCase());
}

function snapshotValidationListPrice(book = {}, snapshot = {}) {
  if (snapshot.listPrice != null) return snapshot.listPrice;
  if (String(snapshot.provider || '').toLowerCase() === 'amazon_html' && snapshot.explicitPriceDisplay) return null;
  return trustedListPriceFor(snapshot.currentPrice, book.listPrice, snapshot.provider);
}

function isSuspiciousSnapshotError(error) {
  return String(error || '').startsWith('疑わしい価格を無視しました');
}

function isTrustedSeriesOverrideSnapshotError(error) {
  return /シリーズ一括取得済み価格/.test(String(error || ''));
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

  if (clearStaleSeriesDerivedListPrice(book, store)) changed = true;
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
    options.clearCurrent &&
    (
      suspiciousStoredCurrentPriceReason(book) ||
      hasUnvalidatedSeriesPrice(book) ||
      ((options.clearStaleDiscountedCurrent || isSuspiciousSnapshotError(book.lastError)) && needsDiscountExpiryRecheck(book))
    );

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
      book.provider = latest.provider || book.provider;
      book.listPrice = trustedListPriceFor(book.currentPrice, latest.listPrice, latest.listPriceProvider || book.provider);
      book.listPriceProvider = book.listPrice == null ? '' : latest.listPriceProvider || book.provider;
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

export function repairStorePriceState(store, options = {}) {
  if (!store || !Array.isArray(store.books)) {
    return {
      changed: false,
      booksRepaired: 0,
      currentCleared: 0,
      currentRestored: 0,
      removedHistory: 0,
      removedNotifications: 0,
      singleSeriesDemoted: 0,
      seriesDiscoveryDeferred: 0,
      removedSeriesNavigationItems: 0,
      removedSupplementalSeriesItems: 0,
      removedSeriesIdentityMismatchItems: 0,
      removedUnvalidatedSeriesTailItems: 0,
      removedDuplicateSeriesVolumeItems: 0,
      repairedSeriesVolumes: 0,
      repairedSeriesExpectedCounts: 0
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
    singleSeriesDemoted: 0,
    seriesDiscoveryDeferred: 0,
    removedSeriesNavigationItems: 0,
    removedSupplementalSeriesItems: 0,
    removedSeriesIdentityMismatchItems: 0,
    removedUnvalidatedSeriesTailItems: 0,
    removedDuplicateSeriesVolumeItems: 0,
    repairedSeriesVolumes: 0,
    repairedSeriesExpectedCounts: 0
  };

  const pseudoItemRepair = repairSeriesNavigationPseudoItems(store, { now });
  if (pseudoItemRepair.changed) {
    summary.changed = true;
    summary.removedSeriesNavigationItems += pseudoItemRepair.removed;
    summary.removedHistory += pseudoItemRepair.removedHistory;
    summary.removedNotifications += pseudoItemRepair.removedNotifications;
    summary.booksRepaired += pseudoItemRepair.expectedCountUpdated;
  }

  const supplementalItemRepair = repairSupplementalSeriesItems(store, { now });
  if (supplementalItemRepair.changed) {
    summary.changed = true;
    summary.removedSupplementalSeriesItems += supplementalItemRepair.removed;
    summary.removedHistory += supplementalItemRepair.removedHistory;
    summary.removedNotifications += supplementalItemRepair.removedNotifications;
    summary.booksRepaired += supplementalItemRepair.expectedCountUpdated;
  }

  const identityMismatchRepair = repairSeriesIdentityMismatchItems(store, { now });
  if (identityMismatchRepair.changed) {
    summary.changed = true;
    summary.removedSeriesIdentityMismatchItems += identityMismatchRepair.removed;
    summary.removedHistory += identityMismatchRepair.removedHistory;
    summary.removedNotifications += identityMismatchRepair.removedNotifications;
    summary.booksRepaired += identityMismatchRepair.expectedCountUpdated;
  }

  const unvalidatedTailRepair = repairUnvalidatedSyntheticTailSeriesItems(store, { now });
  if (unvalidatedTailRepair.changed) {
    summary.changed = true;
    summary.removedUnvalidatedSeriesTailItems += unvalidatedTailRepair.removed;
    summary.removedHistory += unvalidatedTailRepair.removedHistory;
    summary.removedNotifications += unvalidatedTailRepair.removedNotifications;
    summary.booksRepaired += unvalidatedTailRepair.expectedCountUpdated;
  }

  const volumeRepair = repairTrustedStoredSeriesVolumes(store, { now });
  if (volumeRepair.changed) {
    summary.changed = true;
    summary.repairedSeriesVolumes += volumeRepair.repaired;
    summary.repairedSeriesExpectedCounts += volumeRepair.expectedCountUpdated || 0;
    summary.booksRepaired += volumeRepair.repaired;
    summary.booksRepaired += volumeRepair.expectedCountUpdated || 0;
  }

  const duplicateVolumeRepair = repairDuplicateStoredSeriesVolumes(store, { now });
  if (duplicateVolumeRepair.changed) {
    summary.changed = true;
    summary.removedDuplicateSeriesVolumeItems += duplicateVolumeRepair.removed;
    summary.removedHistory += duplicateVolumeRepair.removedHistory;
    summary.removedNotifications += duplicateVolumeRepair.removedNotifications;
    summary.booksRepaired += duplicateVolumeRepair.expectedCountUpdated;
  }

  const expectedCountRepair = repairStaleStoredSeriesExpectedCounts(store, { now });
  if (expectedCountRepair.changed) {
    summary.changed = true;
    summary.repairedSeriesExpectedCounts += expectedCountRepair.repaired;
    summary.booksRepaired += expectedCountRepair.repaired;
  }

  const classificationRepair = repairSingleBookSeriesClassifications(store, { now });
  if (classificationRepair.changed) {
    summary.changed = true;
    summary.singleSeriesDemoted += classificationRepair.demoted;
    summary.removedNotifications += classificationRepair.removedNotifications;
  }

  const seriesNameRepair = repairStoredSeriesNames(store, { now });
  if (seriesNameRepair.changed) {
    summary.changed = true;
    summary.booksRepaired += seriesNameRepair.booksRepaired;
  }

  const discoveryRepair = repairDeferredSeriesDiscoveryErrors(store, { now });
  if (discoveryRepair.changed) {
    summary.changed = true;
    summary.seriesDiscoveryDeferred += discoveryRepair.deferred;
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

  const clearedHistoryListPrices = clearSeriesDerivedListPricesFromHistory(store);
  if (clearedHistoryListPrices > 0) {
    summary.changed = true;
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

function repairDeferredSeriesDiscoveryErrors(store, options = {}) {
  const now = options.now || new Date().toISOString();
  let deferred = 0;
  for (const group of seriesDiscoveryGroups(store.books || [])) {
    const hasDeferrableError = group.books.some(
      (book) =>
        book.seriesDiscoveryStatus === 'error' &&
        /シリーズ内のKindle ASINを取得できませんでした/.test(String(book.seriesDiscoveryError || ''))
    );
    if (!hasDeferrableError || !hasCompleteKnownSeriesCoverage(group)) continue;
    markSeriesDiscoveryDeferredInStore(store, group, now, 'source_unavailable');
    deferred += 1;
  }

  return {
    changed: deferred > 0,
    deferred
  };
}

function repairSeriesNavigationPseudoItems(store, options = {}) {
  const now = options.now || new Date().toISOString();
  const targets = (store.books || []).filter(isSeriesNavigationPseudoItem);
  if (targets.length === 0) {
    return {
      changed: false,
      removed: 0,
      removedHistory: 0,
      removedNotifications: 0,
      expectedCountUpdated: 0
    };
  }

  const ids = new Set(targets.map((book) => book.id));
  const affectedKeys = new Set(targets.map(seriesGroupKeyForBook).filter(Boolean));
  const beforeHistory = store.priceHistory.length;
  const beforeNotifications = store.notifications.length;
  removeStoreBooksById(store, ids);

  let expectedCountUpdated = 0;
  for (const key of affectedKeys) {
    const books = (store.books || []).filter((book) => seriesGroupKeyForBook(book) === key);
    if (books.length === 0) continue;

    const expectedCount = Math.max(
      books.length,
      ...books.map((book) => storedBookVolume(book)).filter((volume) => volume > 0)
    );
    for (const book of books) {
      if (Number(book.seriesExpectedCount || 0) === expectedCount) continue;
      book.seriesExpectedCount = expectedCount;
      book.updatedAt = now;
      expectedCountUpdated += 1;
    }
  }

  return {
    changed: true,
    removed: targets.length,
    removedHistory: beforeHistory - store.priceHistory.length,
    removedNotifications: beforeNotifications - store.notifications.length,
    expectedCountUpdated
  };
}

function repairSupplementalSeriesItems(store, options = {}) {
  const now = options.now || new Date().toISOString();
  const groups = new Map();
  for (const book of store.books || []) {
    if (!isSeriesBookRecord(book)) continue;
    const key = seriesGroupKeyForBook(book);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(book);
  }

  const targets = [];
  for (const books of groups.values()) {
    for (const book of books) {
      if (
        isSupplementalSeriesBookTitle(book.title, book.seriesName) ||
        isClearlyDifferentSeriesTitle(book.title, book.seriesName) ||
        isStoredSeriesCollectionContainerBook(book, books)
      ) {
        targets.push(book);
      }
    }
  }
  if (targets.length === 0) {
    return {
      changed: false,
      removed: 0,
      removedHistory: 0,
      removedNotifications: 0,
      expectedCountUpdated: 0
    };
  }

  const ids = new Set(targets.map((book) => book.id));
  const affectedKeys = new Set(targets.map(seriesGroupKeyForBook).filter(Boolean));
  const beforeHistory = store.priceHistory.length;
  const beforeNotifications = store.notifications.length;
  removeStoreBooksById(store, ids);
  const expectedCountUpdated = normalizeExpectedCountForSeriesKeys(store, affectedKeys, now);

  return {
    changed: true,
    removed: targets.length,
    removedHistory: beforeHistory - store.priceHistory.length,
    removedNotifications: beforeNotifications - store.notifications.length,
    expectedCountUpdated
  };
}

function repairSeriesIdentityMismatchItems(store, options = {}) {
  const now = options.now || new Date().toISOString();
  const groups = new Map();
  for (const book of store.books || []) {
    if (!isSeriesBookRecord(book)) continue;
    const key = seriesGroupKeyForBook(book);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(book);
  }

  const targets = [];
  for (const books of groups.values()) {
    if (books.length < 3) continue;
    const canonical = canonicalSeriesNameByBookCount(books);
    if (!canonical) continue;

    for (const book of books) {
      const currentName = cleanStoredSeriesName(book.seriesName || '');
      if (!currentName || currentName === canonical) continue;
      if (!isClearlyDifferentSeriesTitle(book.title, canonical)) continue;
      targets.push(book);
    }
  }

  if (targets.length === 0) {
    return {
      changed: false,
      removed: 0,
      removedHistory: 0,
      removedNotifications: 0,
      expectedCountUpdated: 0
    };
  }

  const ids = new Set(targets.map((book) => book.id));
  const affectedKeys = new Set(targets.map(seriesGroupKeyForBook).filter(Boolean));
  const beforeHistory = store.priceHistory.length;
  const beforeNotifications = store.notifications.length;
  removeStoreBooksById(store, ids);
  const expectedCountUpdated = normalizeExpectedCountForSeriesKeys(store, affectedKeys, now);

  return {
    changed: true,
    removed: targets.length,
    removedHistory: beforeHistory - store.priceHistory.length,
    removedNotifications: beforeNotifications - store.notifications.length,
    expectedCountUpdated
  };
}

function canonicalSeriesNameByBookCount(books = []) {
  const counts = new Map();
  for (const book of books) {
    const name = cleanStoredSeriesName(book.seriesName || '');
    if (!name || isGenericSeriesName(name)) continue;
    const current = counts.get(name) || { name, count: 0, firstVolume: Number.POSITIVE_INFINITY };
    current.count += 1;
    const volume = storedBookVolume(book);
    if (volume > 0) current.firstVolume = Math.min(current.firstVolume, volume);
    counts.set(name, current);
  }
  if (counts.size < 2) return '';

  const ranked = [...counts.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return left.firstVolume - right.firstVolume;
  });
  if (ranked[0].count === ranked[1].count) return '';
  return ranked[0].name;
}

function isStoredSeriesCollectionContainerBook(book = {}, groupBooks = []) {
  if (!book?.asin || !book.seriesName) return false;

  const titleCore = seriesTitleComparisonCore(book.title);
  const seriesCore = seriesTitleComparisonCore(book.seriesName);
  if (!titleCore || !seriesCore || titleCore !== seriesCore) return false;
  const sourceAsin = extractAsin(book.sourceUrl || book.seriesKey || '');
  if (isLikelySeriesContainerCandidate(book, sourceAsin, groupBooks, book.seriesName)) return true;
  if (trustedVolumeFromStoredBookTitle(book) > 0) return false;

  const siblingTrustedBooks = groupBooks
    .filter((item) => item?.id !== book.id)
    .map((item) => ({ item, volume: trustedVolumeFromStoredBookTitle(item) }))
    .filter(({ volume }) => Number.isFinite(volume) && volume > 0);
  if (siblingTrustedBooks.length < 2) return false;

  const storedVolume = storedBookVolume(book);
  const siblingTrustedVolumes = siblingTrustedBooks.map(({ volume }) => volume);
  const maxSiblingVolume = Math.max(...siblingTrustedVolumes);
  if (!storedVolume || storedVolume > maxSiblingVolume) return true;

  const storedVolumeCollidesWithSibling = siblingTrustedVolumes.includes(storedVolume);
  if (
    (storedVolumeCollidesWithSibling || sourceAsin === String(book.asin || '').toUpperCase()) &&
    storedBookPriceLooksLikeSeriesTotal(
      book,
      siblingTrustedBooks.map(({ item }) => item)
    )
  ) {
    return true;
  }

  return false;
}

function storedBookPriceLooksLikeSeriesTotal(book = {}, siblingBooks = []) {
  const currentTotal = sumStoredPrices(siblingBooks, 'currentPrice');
  const effectiveTotal = sumStoredPrices(siblingBooks, 'effectivePrice');
  const totals = [currentTotal, effectiveTotal].filter((value) => Number.isFinite(value) && value > 0);
  if (totals.length === 0) return false;

  const prices = [storedPositiveNumber(book.currentPrice), storedPositiveNumber(book.effectivePrice)].filter(
    (value) => Number.isFinite(value) && value > 0
  );
  return totals.some((total) => prices.some((price) => nearlySameSeriesTotalPrice(price, total)));
}

function sumStoredPrices(books = [], field) {
  const prices = books.map((book) => storedPositiveNumber(book?.[field])).filter((value) => Number.isFinite(value) && value > 0);
  if (prices.length < 2) return null;
  return prices.reduce((sum, value) => sum + value, 0);
}

function storedPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nearlySameSeriesTotalPrice(price, total) {
  return Math.abs(price - total) <= Math.max(2, Math.round(total * 0.005));
}

function repairUnvalidatedSyntheticTailSeriesItems(store, options = {}) {
  const now = options.now || new Date().toISOString();
  const ids = new Set();
  const affectedKeys = new Set();
  const groups = new Map();

  for (const book of store.books || []) {
    if (!isSeriesBookRecord(book)) continue;
    const key = seriesGroupKeyForBook(book);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(book);
  }

  for (const [key, books] of groups.entries()) {
    if (books.length < 3) continue;

    const candidateIds = new Set(
      books.filter(isUnvalidatedSyntheticStoredSeriesItem).map((book) => book.id)
    );
    if (candidateIds.size === 0) continue;

    const confirmedVolumes = books
      .filter((book) => !candidateIds.has(book.id))
      .map(storedBookVolume)
      .filter((volume) => Number.isFinite(volume) && volume > 0);
    if (confirmedVolumes.length < 3) continue;

    const maxConfirmedVolume = Math.max(...confirmedVolumes);
    for (const book of books) {
      if (!candidateIds.has(book.id)) continue;
      if (storedBookVolume(book) <= maxConfirmedVolume) continue;
      if (isExpectedSingleUnvalidatedTailBook(book, candidateIds)) continue;
      ids.add(book.id);
      affectedKeys.add(key);
    }
  }

  if (ids.size === 0) {
    return {
      changed: false,
      removed: 0,
      removedHistory: 0,
      removedNotifications: 0,
      expectedCountUpdated: 0
    };
  }

  const beforeHistory = store.priceHistory.length;
  const beforeNotifications = store.notifications.length;
  removeStoreBooksById(store, ids);
  const expectedCountUpdated = normalizeExpectedCountForSeriesKeys(store, affectedKeys, now);

  return {
    changed: true,
    removed: ids.size,
    removedHistory: beforeHistory - store.priceHistory.length,
    removedNotifications: beforeNotifications - store.notifications.length,
    expectedCountUpdated
  };
}

function isUnvalidatedSyntheticStoredSeriesItem(book = {}) {
  const volume = storedBookVolume(book);
  if (!volume) return false;
  if (!isUnvalidatedSyntheticTailTitle(book, book.seriesName, volume)) return false;
  if (
    book.currentPrice == null &&
    hasSpecificStoredSeriesChildEvidence(book, volume)
  ) {
    return false;
  }
  if (isUnresolvedAsinPlaceholderTitle(book.title, book.asin) && book.currentPrice == null) return true;
  if (book.currentPrice == null) return true;

  const provider = String(book.provider || '').toLowerCase();
  if (
    provider === 'pending' ||
    provider === 'pending_series' ||
    provider === 'series_diff_pending' ||
    isUnvalidatedSeriesPriceProvider(provider)
  ) {
    return true;
  }
  return /シリーズ価格補完|価格を取得できません|タイムアウト|aborted/i.test(String(book.lastError || ''));
}

function hasSpecificStoredSeriesChildEvidence(book = {}, volume = 0) {
  if (book.imageUrl) return true;
  if (isUnresolvedAsinPlaceholderTitle(book.title, book.asin)) return false;
  return !isBareSyntheticStoredSeriesVolumeTitle(book.title, book.seriesName, volume);
}

function isBareSyntheticStoredSeriesVolumeTitle(title = '', seriesName = '', volume = 0) {
  const titleText = String(title || '').normalize('NFKC').replace(/\s+/g, '');
  const seriesText = String(seriesName || '').normalize('NFKC').replace(/\s+/g, '');
  if (!titleText || !seriesText || !volume) return false;
  const number = String(Number(volume));
  const variants = [
    `${seriesText}${number}`,
    `${seriesText}${number}巻`,
    `${seriesText}(${number})`,
    `${seriesText}(${number}巻)`
  ];
  return variants.includes(titleText);
}

function isExpectedSingleUnvalidatedTailBook(book = {}, candidateIds = new Set()) {
  if (candidateIds.size !== 1) return false;
  if (isUnresolvedAsinPlaceholderTitle(book.title, book.asin)) return false;
  const volume = storedBookVolume(book);
  const expected = Number(book.seriesExpectedCount || 0);
  return Number.isFinite(volume) && volume > 0 && Number.isFinite(expected) && expected === volume;
}

function repairTrustedStoredSeriesVolumes(store, options = {}) {
  const now = options.now || new Date().toISOString();
  let repaired = 0;
  const affectedKeys = new Set();
  for (const book of store.books || []) {
    if (!isSeriesBookRecord(book)) continue;
    const fixup = STORED_SERIES_BOOK_FIXUPS.get(String(book.asin || '').toUpperCase());
    const trustedVolume =
      fixup?.volume || (shouldTrustStoredSeriesChildVolume(book) ? 0 : trustedVolumeFromStoredBookTitle(book));
    let changed = false;
    if (trustedVolume && Number(book.volume || 0) !== trustedVolume) {
      book.volume = trustedVolume;
      changed = true;
    }
    if (fixup?.title && book.title !== fixup.title) {
      book.title = fixup.title;
      changed = true;
    }
    if (!changed) continue;
    book.updatedAt = now;
    const key = seriesGroupKeyForBook(book);
    if (key) affectedKeys.add(key);
    repaired += 1;
  }

  const expectedCountUpdated = normalizeExpectedCountForSeriesKeys(store, affectedKeys, now);
  return {
    changed: repaired > 0 || expectedCountUpdated > 0,
    repaired,
    expectedCountUpdated
  };
}

function shouldTrustStoredSeriesChildVolume(book = {}) {
  if (AUTHORITATIVE_MIXED_EDITION_SERIES_KEYS.has(seriesGroupKeyForBook(book))) return true;
  const sourceAsin = extractAsin(book.sourceUrl || '');
  return Boolean(sourceAsin && AUTHORITATIVE_MIXED_EDITION_SERIES_KEYS.has(`series:asin:${sourceAsin}`));
}

function repairDuplicateStoredSeriesVolumes(store, options = {}) {
  const now = options.now || new Date().toISOString();
  const ids = new Set();
  const affectedKeys = new Set();
  const groups = new Map();

  for (const book of store.books || []) {
    if (!isSeriesBookRecord(book)) continue;
    const key = seriesGroupKeyForBook(book);
    const volume = storedBookVolume(book);
    if (!key || !volume) continue;
    const volumeKey = `${key}\u0000${volume}`;
    if (!groups.has(volumeKey)) groups.set(volumeKey, { key, volume, books: [] });
    groups.get(volumeKey).books.push(book);
  }

  for (const group of groups.values()) {
    if (group.books.length <= 1) continue;
    const keep = preferredStoredSeriesDuplicateBook(group.books, group.volume);
    if (!keep) continue;
    for (const book of group.books) {
      if (book.id === keep.id) continue;
      if (!isDroppableStoredSeriesDuplicate(book, keep, group.volume, group.key)) continue;
      ids.add(book.id);
      affectedKeys.add(group.key);
    }
  }

  if (ids.size === 0) {
    return {
      changed: false,
      removed: 0,
      removedHistory: 0,
      removedNotifications: 0,
      expectedCountUpdated: 0
    };
  }

  const beforeHistory = store.priceHistory.length;
  const beforeNotifications = store.notifications.length;
  removeStoreBooksById(store, ids);
  const expectedCountUpdated = normalizeExpectedCountForSeriesKeys(store, affectedKeys, now);

  return {
    changed: true,
    removed: ids.size,
    removedHistory: beforeHistory - store.priceHistory.length,
    removedNotifications: beforeNotifications - store.notifications.length,
    expectedCountUpdated
  };
}

function preferredStoredSeriesDuplicateBook(books = [], volume = 0) {
  return [...books].sort((left, right) => {
    const leftTitleVolume = trustedVolumeFromStoredBookTitle(left) === volume ? 1 : 0;
    const rightTitleVolume = trustedVolumeFromStoredBookTitle(right) === volume ? 1 : 0;
    if (leftTitleVolume !== rightTitleVolume) return rightTitleVolume - leftTitleVolume;

    const leftNonBook = isNonBookSeriesCandidateItem(left) ? 1 : 0;
    const rightNonBook = isNonBookSeriesCandidateItem(right) ? 1 : 0;
    if (leftNonBook !== rightNonBook) return leftNonBook - rightNonBook;

    const editionRank = alternativeEditionRank(left) - alternativeEditionRank(right);
    if (editionRank !== 0) return editionRank;

    const metadataRank = storedSeriesMetadataQualityRank(right) - storedSeriesMetadataQualityRank(left);
    if (metadataRank !== 0) return metadataRank;

    const providerRank = seriesPriceProviderRank(right.provider) - seriesPriceProviderRank(left.provider);
    if (providerRank !== 0) return providerRank;

    const leftChecked = Date.parse(left.lastCheckedAt || left.updatedAt || left.createdAt || '') || 0;
    const rightChecked = Date.parse(right.lastCheckedAt || right.updatedAt || right.createdAt || '') || 0;
    if (leftChecked !== rightChecked) return rightChecked - leftChecked;

    return String(left.title || left.asin).localeCompare(String(right.title || right.asin), 'ja');
  })[0] || null;
}

function isDroppableStoredSeriesDuplicate(book = {}, keep = {}, volume = 0, seriesKey = '') {
  if (!book?.id || book.id === keep?.id) return false;
  if (isNonBookSeriesCandidateItem(book)) return true;
  if (isSupplementalSeriesBookTitle(book.title, book.seriesName)) return true;
  if (alternativeEditionRank(book) > alternativeEditionRank(keep)) return true;

  const bookTitleVolume = trustedVolumeFromStoredBookTitle(book);
  const keepTitleVolume = trustedVolumeFromStoredBookTitle(keep);
  if (!STALE_SERIES_EXPECTED_COUNT_OVERRIDES.has(seriesKey)) return false;
  if (keepTitleVolume === volume && bookTitleVolume !== volume) return true;
  if (
    storedDuplicateTitleKey(book.title) &&
    storedDuplicateTitleKey(book.title) === storedDuplicateTitleKey(keep.title) &&
    storedSeriesMetadataQualityRank(keep) > storedSeriesMetadataQualityRank(book)
  ) {
    return true;
  }
  return false;
}

function storedSeriesMetadataQualityRank(book = {}) {
  let rank = 0;
  if (book.author) rank += 4;
  if (book.publisher) rank += 2;
  if (book.imageUrl || book.imageKey) rank += 1;
  if (book.currentPrice != null) rank += 1;
  return rank;
}

function storedDuplicateTitleKey(title) {
  return seriesTitleComparisonStem(title);
}

function repairStaleStoredSeriesExpectedCounts(store, options = {}) {
  const now = options.now || new Date().toISOString();
  const groups = new Map();
  for (const book of store.books || []) {
    if (!isSeriesBookRecord(book)) continue;
    const key = seriesGroupKeyForBook(book);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(book);
  }

  let repaired = 0;
  for (const [key, books] of groups.entries()) {
    const expected = repairedSeriesExpectedCountForGroup(key, books);
    if (!expected) continue;
    for (const book of books) {
      if (Number(book.seriesExpectedCount || 0) === expected) continue;
      book.seriesExpectedCount = expected;
      book.updatedAt = now;
      repaired += 1;
    }
  }

  return {
    changed: repaired > 0,
    repaired
  };
}

function repairedSeriesExpectedCountForGroup(key, books = []) {
  const override = STALE_SERIES_EXPECTED_COUNT_OVERRIDES.get(key);
  if (override && shouldApplySeriesExpectedCountOverride(books, override)) return override;

  const childSourceExpected = repairedChildSourceSeriesExpectedCount(books);
  if (childSourceExpected) return childSourceExpected;

  const volumes = books.map(storedBookVolume).filter((volume) => Number.isFinite(volume) && volume > 0);
  if (!books.some((book) => book.seriesCompleted)) return 0;
  if (!isContiguousOneBasedVolumeSet(volumes, books.length)) return 0;
  const maxVolume = Math.max(...volumes, 0);
  const currentExpected = Math.max(...books.map((book) => Number(book.seriesExpectedCount || 0)), 0);
  if (currentExpected <= maxVolume) return 0;
  return maxVolume;
}

function repairedChildSourceSeriesExpectedCount(books = []) {
  if (books.length < 2) return 0;

  const volumes = books.map(storedBookVolume).filter((volume) => Number.isFinite(volume) && volume > 0);
  if (!isContiguousOneBasedVolumeSet(volumes, books.length)) return 0;

  const maxVolume = Math.max(...volumes, 0);
  const currentExpected = Math.max(...books.map((book) => Number(book.seriesExpectedCount || 0)), 0);
  if (currentExpected !== maxVolume + 1) return 0;

  const bookAsins = new Set(books.map((book) => String(book.asin || '').toUpperCase()).filter(Boolean));
  const sourceAsins = new Set();
  for (const book of books) {
    const sourceAsin = extractAsin(book.sourceUrl || '');
    if (sourceAsin) sourceAsins.add(sourceAsin);
    const keyAsin = String(book.seriesKey || '').match(/^series:asin:([A-Z0-9]{10})$/i)?.[1]?.toUpperCase();
    if (keyAsin) sourceAsins.add(keyAsin);
  }

  for (const sourceAsin of sourceAsins) {
    if (!bookAsins.has(sourceAsin)) continue;
    const sourceBook = books.find((book) => String(book.asin || '').toUpperCase() === sourceAsin);
    if (storedBookVolume(sourceBook) !== 1) continue;
    return maxVolume;
  }

  return 0;
}

function shouldApplySeriesExpectedCountOverride(books = [], expected = 0) {
  if (!expected || books.length === 0) return false;
  const volumes = books.map(storedBookVolume).filter((volume) => Number.isFinite(volume) && volume > 0);
  if (volumes.some((volume) => volume > expected)) return false;
  if (books.length > expected) return false;
  return isContiguousOneBasedVolumeSet(volumes, Math.min(books.length, expected));
}

function isContiguousOneBasedVolumeSet(volumes = [], expectedSize = 0) {
  if (!expectedSize || volumes.length !== expectedSize) return false;
  const unique = new Set(volumes);
  if (unique.size !== volumes.length) return false;
  for (let volume = 1; volume <= expectedSize; volume += 1) {
    if (!unique.has(volume)) return false;
  }
  return true;
}

function normalizeExpectedCountForSeriesKeys(store, affectedKeys, now) {
  let expectedCountUpdated = 0;
  for (const key of affectedKeys || []) {
    const books = (store.books || []).filter((book) => seriesGroupKeyForBook(book) === key);
    if (books.length === 0) continue;

    const expectedCount = Math.max(
      books.length,
      ...books.map((book) => storedBookVolume(book)).filter((volume) => volume > 0)
    );
    for (const book of books) {
      if (Number(book.seriesExpectedCount || 0) === expectedCount) continue;
      book.seriesExpectedCount = expectedCount;
      book.updatedAt = now;
      expectedCountUpdated += 1;
    }
  }
  return expectedCountUpdated;
}

function repairStoredSeriesNames(store, options = {}) {
  const now = options.now || new Date().toISOString();
  const groups = new Map();
  for (const [index, book] of (store.books || []).entries()) {
    if (!isSeriesBookRecord(book)) continue;
    const key = book.seriesKey || book.sourceUrl || `series:${book.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ book, index });
  }

  let booksRepaired = 0;
  for (const entries of groups.values()) {
    const books = entries.map((entry) => entry.book);
    const canonical = canonicalStoredSeriesName(books);
    if (!canonical) continue;

    const previousVolumes = new Map(books.map((book) => [book, book.volume]));
    if (!books.some(shouldTrustStoredSeriesChildVolume)) {
      repairSequentialStoredSeriesVolumes(entries);
    }
    const previousNames = [...new Set(books.map((book) => String(book.seriesName || '').trim()).filter(Boolean))];
    for (const book of books) {
      let changed = false;
      if (String(previousVolumes.get(book) || '') !== String(book.volume || '')) {
        changed = true;
      }
      if (book.seriesName !== canonical) {
        book.seriesName = canonical;
        changed = true;
      }
      if (shouldRepairStoredSeriesBookTitle(book, previousNames)) {
        book.title = storedSeriesVolumeTitle(canonical, storedBookVolume(book));
        changed = true;
      }
      if (changed) {
        book.updatedAt = now;
        booksRepaired += 1;
      }
    }
  }

  return {
    changed: booksRepaired > 0,
    booksRepaired
  };
}

function repairSequentialStoredSeriesVolumes(entries = []) {
  if (entries.length < 3) return 0;

  const ordered = [...entries].sort((left, right) => left.index - right.index);
  const volumes = ordered.map((entry) => storedBookVolume(entry.book));
  const nonZero = volumes.filter((volume) => volume > 0);
  if (nonZero.length < 2) return 0;

  const uniqueVolumes = new Set(nonZero);
  const hasDuplicateVolumes = uniqueVolumes.size < nonZero.length;
  if (!hasDuplicateVolumes) return 0;

  const maxStoredVolume = Math.max(...nonZero);
  const expectedCount = Math.max(
    ordered.length,
    ...ordered.map((entry) => Number(entry.book.seriesExpectedCount) || 0)
  );
  const sequentialMatches = volumes.filter((volume, index) => volume === index + 1).length;
  const strongSequentialEvidence = sequentialMatches >= Math.max(2, Math.floor(ordered.length * 0.6));
  const boundedCompleteSeries = expectedCount === ordered.length && maxStoredVolume <= ordered.length;
  if (!strongSequentialEvidence && !boundedCompleteSeries) return 0;

  let repaired = 0;
  for (const [index, entry] of ordered.entries()) {
    const expectedVolume = index + 1;
    if (storedBookVolume(entry.book) === expectedVolume) continue;
    entry.book.volume = expectedVolume;
    repaired += 1;
  }
  return repaired;
}

function isSeriesBookRecord(book = {}) {
  return (
    book.importMode === 'kindle_series' ||
    Boolean(book.seriesKey) ||
    Number(book.seriesExpectedCount || 0) > 1
  );
}

function canonicalStoredSeriesName(books = []) {
  const candidates = [];
  for (const book of books) {
    addStoredSeriesNameCandidate(candidates, book.seriesName, 0);
    addStoredSeriesNameCandidate(candidates, book.title, 1);
  }
  if (candidates.length === 0) return '';

  const counts = new Map();
  for (const candidate of candidates) {
    const current = counts.get(candidate.name) || { ...candidate, count: 0 };
    current.count += 1;
    current.rank = Math.min(current.rank, candidate.rank);
    counts.set(candidate.name, current);
  }

  return [...counts.values()].sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    if (left.dirty !== right.dirty) return Number(left.dirty) - Number(right.dirty);
    if (left.count !== right.count) return right.count - left.count;
    if (left.name.length !== right.name.length) return left.name.length - right.name.length;
    return left.name.localeCompare(right.name, 'ja');
  })[0]?.name || '';
}

function addStoredSeriesNameCandidate(candidates, value, rank) {
  const raw = String(value || '').trim();
  const cleaned = cleanStoredSeriesName(raw);
  if (!cleaned || cleaned === 'Kindle シリーズ' || isGenericSeriesName(cleaned)) return;
  candidates.push({
    name: cleaned,
    rank,
    dirty: isDirtyAmazonSeriesText(raw)
  });
}

function cleanStoredSeriesName(value) {
  return cleanAmazonSeriesName(value || 'Kindle シリーズ');
}

function shouldRepairStoredSeriesBookTitle(book, previousNames = []) {
  const title = String(book?.title || '').trim();
  if (!title) return true;
  if (isDirtyAmazonSeriesText(title)) return true;
  if (shouldCanonicalizeStoredSeriesBookTitle(book)) return true;
  return previousNames.some((name) => name && name !== book.seriesName && title.startsWith(name));
}

function shouldCanonicalizeStoredSeriesBookTitle(book = {}) {
  const fixup = STORED_SERIES_BOOK_FIXUPS.get(String(book.asin || '').toUpperCase());
  if (fixup?.title && String(book.title || '').trim() === fixup.title) return false;
  if (isKnownMixedEditionSeriesTitle(book.title, book.seriesName)) return false;
  const childListVolumeIsTrusted = shouldTrustStoredSeriesChildVolume(book);
  if (childListVolumeIsTrusted) return false;
  if (!childListVolumeIsTrusted && !isSeriesDerivedPriceProvider(book.provider)) return false;
  if (!book.seriesName || storedBookVolume(book) <= 0) return false;
  const canonical = storedSeriesVolumeTitle(book.seriesName, storedBookVolume(book));
  if (String(book.title || '').trim() === canonical) return false;
  const titleCore = seriesTitleComparisonCore(book.title);
  const seriesCore = seriesTitleComparisonCore(book.seriesName);
  return (
    cleanStoredSeriesName(book.title) === cleanStoredSeriesName(book.seriesName) ||
    Boolean(titleCore && seriesCore && titleCore.includes(seriesCore))
  );
}

function storedBookVolume(book = {}) {
  const volume = Number(book.volume);
  return Number.isFinite(volume) && volume > 0 ? volume : seriesItemVolume(book);
}

function isDirtyAmazonSeriesText(value) {
  return /Amazon\.co\.jp:|Kindleストア|Kindle Store|\beBook\s*[:：]|電子書籍\s*[:：]/i.test(String(value || ''));
}

function storedSeriesVolumeTitle(seriesName, volume) {
  const number = Number(volume);
  if (!Number.isFinite(number) || number <= 0) return seriesName;
  return `${seriesName} ${toFullWidthNumber(number)}`;
}

function toFullWidthNumber(value) {
  return String(value).replace(/[0-9]/g, (number) => String.fromCharCode(number.charCodeAt(0) + 0xfee0));
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
    explicitPriceDisplay: book.explicitPriceDisplay,
    explicitFreeKindlePrice: book.explicitFreeKindlePrice,
    referencePrices: [
      listPrice,
      book.previousEffectivePrice,
      book.lowestPrice && Number(book.lowestPrice) !== Number(book.currentPrice) ? book.lowestPrice : null
    ]
  });
}

function isSuspiciousHistoryEntry(entry, book) {
  if (isStaleDiscountInferredHistoryEntry(entry, book)) return true;

  const provider = entry.provider || book.provider;
  const listPrice = trustedListPriceFor(entry.price, entry.listPrice ?? book.listPrice, provider);
  return Boolean(
    suspiciousPriceReason({
      price: entry.price,
      points: entry.points,
      effectivePrice: entry.effectivePrice,
      listPrice,
      provider,
      explicitPriceDisplay: entry.explicitPriceDisplay,
      explicitFreeKindlePrice: entry.explicitFreeKindlePrice,
      referencePrices: [book.currentPrice, book.effectivePrice, book.previousEffectivePrice, listPrice]
    })
  );
}

function isStaleDiscountInferredHistoryEntry(entry, book) {
  const provider = String(entry?.provider || book?.provider || '').toLowerCase();
  if (provider !== 'amazon_html') return false;

  const historyPrice = Number(entry?.price);
  const currentPrice = Number(book?.currentPrice);
  const points = Number(entry?.points || 0);
  const listPrice = Number(entry?.listPrice ?? book?.listPrice);
  if (!Number.isFinite(historyPrice) || historyPrice <= 0) return false;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false;
  if (!Number.isFinite(points) || points <= 0) return false;
  if (!Number.isFinite(listPrice) || listPrice < 1000) return false;

  const looksLikeDeepDiscount = historyPrice <= listPrice * 0.15 && points / historyPrice >= 0.2;
  const wasReplacedByHigherExplicitPrice = currentPrice >= historyPrice * 2;
  return looksLikeDeepDiscount && wasReplacedByHigherExplicitPrice;
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
  if (!shouldIgnoreListPriceForProvider(book.currentPrice, book.listPrice, listPriceProviderForBook(book))) return false;
  book.listPrice = null;
  book.listPriceProvider = '';
  return true;
}

function clearStaleSeriesDerivedListPrice(book, store) {
  const listPrice = nullableNumber(book?.listPrice);
  if (listPrice == null) return false;

  const listPriceProvider = listPriceProviderForBook(book);
  const shouldClear =
    isSeriesDerivedPriceProvider(listPriceProvider) ||
    (!book.listPriceProvider && hasSeriesDerivedListPriceHistory(book, store, listPrice));
  if (!shouldClear) return false;

  let changed = false;
  if (book.listPrice != null) {
    book.listPrice = null;
    book.listPriceProvider = '';
    changed = true;
  }

  const history = Array.isArray(store?.priceHistory) ? store.priceHistory : [];
  for (const entry of history) {
    if (!isPriceHistoryEntryForBook(entry, book)) continue;
    if (nullableNumber(entry.listPrice) !== listPrice) continue;
    if (entry.listPrice == null) continue;
    entry.listPrice = null;
    changed = true;
  }

  return changed;
}

function clearSeriesDerivedListPricesFromHistory(store) {
  const history = Array.isArray(store?.priceHistory) ? store.priceHistory : [];
  let cleared = 0;
  for (const entry of history) {
    if (entry?.listPrice == null) continue;
    if (!isSeriesDerivedPriceProvider(entry.listPriceProvider || entry.provider)) continue;
    entry.listPrice = null;
    entry.listPriceProvider = '';
    cleared += 1;
  }
  return cleared;
}

function hasSeriesDerivedListPriceHistory(book, store, listPrice) {
  const history = Array.isArray(store?.priceHistory) ? store.priceHistory : [];
  return history.some(
    (entry) =>
      isPriceHistoryEntryForBook(entry, book) &&
      nullableNumber(entry.listPrice) === listPrice &&
      isSeriesDerivedPriceProvider(entry.listPriceProvider || entry.provider)
  );
}

function isPriceHistoryEntryForBook(entry, book) {
  if (!entry || !book) return false;
  if (entry.bookId && book.id && entry.bookId === book.id) return true;
  if (entry.asin && book.asin && String(entry.asin).toUpperCase() === String(book.asin).toUpperCase()) return true;
  return false;
}

function trustedListPriceFor(currentPrice, listPrice, provider) {
  return shouldIgnoreListPriceForProvider(currentPrice, listPrice, provider) ? null : listPrice ?? null;
}

function listPriceProviderForBook(book = {}) {
  return book.listPriceProvider || book.provider || '';
}

function applyMergedSnapshotListPrice(book, snapshot) {
  const provider = listPriceProviderForBook(book);
  const listPrice = mergedSnapshotListPrice(snapshot, book.listPrice, provider);
  book.listPrice = listPrice;
  if (listPrice == null) {
    book.listPriceProvider = '';
  } else if (snapshot?.listPrice != null) {
    book.listPriceProvider = snapshot.provider || book.listPriceProvider || book.provider || '';
  }
}

export function mergedSnapshotListPrice(snapshot, existingListPrice, existingProvider = '') {
  if (snapshot?.listPrice != null) return snapshot.listPrice;
  if (isObservedListPriceProvider(existingProvider)) return existingListPrice ?? null;
  return String(snapshot?.provider || '').toLowerCase() === 'amazon_html' ? null : existingListPrice;
}

function shouldIgnoreListPriceForProvider(currentPrice, listPrice, provider) {
  return isSeriesDerivedPriceProvider(provider);
}

function isObservedListPriceProvider(provider) {
  const normalized = String(provider || '').toLowerCase();
  return normalized === OBSERVED_LIST_PRICE_PROVIDER || normalized === OBSERVED_PEER_LIST_PRICE_PROVIDER;
}

function isSeriesDerivedPriceProvider(provider) {
  const normalized = String(provider || '').toLowerCase();
  return normalized.includes('_series') || normalized === 'amazon_series_bulk' || normalized === 'amazon_series_reader';
}

export function suspiciousPriceReason({
  price,
  points = 0,
  effectivePrice = null,
  listPrice = null,
  provider = '',
  referencePrices = [],
  explicitPriceDisplay = false,
  explicitFreeKindlePrice = false
}) {
  const current = Number(price);
  const pointValue = Number(points || 0);
  const reference = Math.max(
    ...referencePrices
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  if (!Number.isFinite(current)) return '';
  if (isLikelyAmazonHtmlTinyContamination({
    price: current,
    provider,
    reference,
    explicitPriceDisplay,
    explicitFreeKindlePrice
  })) {
    return current === 0 ? 'Amazon HTML価格が不自然に0円です' : 'Amazon HTML価格が不自然に小さすぎます';
  }
  if (isLikelyLowConfidenceReaderPrice({ price: current, provider, reference })) {
    return 'Amazon reader価格が基準価格に対して低すぎます';
  }
  if (current <= 0) return '';

  if (Number.isFinite(pointValue) && pointValue > current) return 'ポイントが価格を超えています';

  const list = Number(listPrice);
  if (Number.isFinite(list) && list > 0 && current > list * 1.15) return '価格が定価を大きく超えています';
  if (isLikelyPercentContaminatedStoredPrice({ price: current, points: pointValue, listPrice: list, provider })) {
    return '価格が割引率またはポイント率に見えます';
  }

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

function isLikelyAmazonHtmlTinyContamination({
  price,
  provider = '',
  reference = 0,
  explicitPriceDisplay = false,
  explicitFreeKindlePrice = false
}) {
  const current = Number(price);
  if (!Number.isFinite(current) || current < 0 || current > AMAZON_HTML_TINY_PRICE_MAX) return false;
  if (!isAmazonHtmlLikePriceProvider(provider)) return false;
  if (current === 0 && explicitFreeKindlePrice) return false;
  if (current > 0 && explicitPriceDisplay) return false;
  return true;
}

function isAmazonHtmlLikePriceProvider(provider) {
  return ['amazon_html', 'amazon_search'].includes(String(provider || '').toLowerCase());
}

function isLikelyLowConfidenceReaderPrice({ price, provider = '', reference = 0 }) {
  if (String(provider || '').toLowerCase() !== 'amazon_reader') return false;
  const current = Number(price);
  const baseline = Number(reference);
  if (!Number.isFinite(current) || current <= 5) return false;
  if (!Number.isFinite(baseline) || baseline < 100) return false;
  return current <= baseline * 0.7;
}

function isLikelyPercentContaminatedStoredPrice({ price, points = 0, listPrice = null, provider = '' }) {
  if (String(provider || '').toLowerCase() !== 'amazon_html') return false;
  const current = Number(price);
  const pointValue = Number(points || 0);
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(pointValue) || pointValue <= 0) return false;

  const list = Number(listPrice);
  const pointRatio = pointValue / current;
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
  if (normalized === 'validated_series_fallback') return 83;
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
    'validated_series_fallback',
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
    if (isNonBookSeriesCandidateItem(item)) continue;
    if (item.asin) merged.set(item.asin, item);
  }
  const currentSeriesAsins = new Set(merged.keys());

  for (const book of books) {
    if (!isKnownBookForSeries(book, options) || merged.has(book.asin)) continue;
    if (isNonBookSeriesCandidateItem(book)) continue;
    if (isLikelyObsoleteSeriesContainerBook(book, currentSeriesAsins, items, options.seriesName)) continue;
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
  if (isSupplementalSeriesBookTitle(book.title, seriesName || book.seriesName)) return true;
  if (isSingleEpisodeLikeTitle(book.title)) return true;
  return isCheapAmazonBulkSeriesBook(book);
}

function isLikelyObsoleteSeriesContainerBook(book, currentSeriesAsins, currentItems = [], seriesName = '') {
  if (!book?.asin || currentSeriesAsins.has(book.asin)) return false;
  const sourceAsin = sourceAsinForSeriesContainerCheck({}, book);
  return isLikelySeriesContainerCandidate(book, sourceAsin, currentItems, seriesName || book.seriesName);
}

function isLikelySeriesContainerCandidateItem(item, seriesIdentity = {}, allItems = [], seriesName = '') {
  const sourceAsin = sourceAsinForSeriesContainerCheck(seriesIdentity, item);
  return isLikelySeriesContainerCandidate(item, sourceAsin, allItems, seriesName || seriesIdentity.seriesName || item?.seriesName);
}

function sourceAsinForSeriesContainerCheck(seriesIdentity = {}, record = {}) {
  return String(seriesIdentity.sourceAsin || '').toUpperCase() ||
    extractAsin(seriesIdentity.sourceUrl || record.sourceUrl || seriesIdentity.seriesKey || record.seriesKey || '');
}

function isLikelySeriesContainerCandidate(record = {}, sourceAsin = '', peerItems = [], seriesName = '') {
  const asin = String(record?.asin || '').toUpperCase();
  if (!asin || !sourceAsin || asin !== String(sourceAsin).toUpperCase()) return false;

  const titleCore = seriesTitleComparisonCore(record.title);
  const seriesCore = seriesTitleComparisonCore(seriesName || record.seriesName);
  if (!titleCore || !seriesCore || titleCore !== seriesCore) return false;

  const peerVolumes = peerItems
    .filter((item) => String(item?.asin || '').toUpperCase() !== asin)
    .map((item) => storedBookVolume(item) || seriesItemVolume(item))
    .filter((volume) => Number.isFinite(volume) && volume > 0);
  if (peerVolumes.length < 2) return false;

  const ownVolume = storedBookVolume(record) || seriesItemVolume(record);
  if (!ownVolume) return false;

  const maxPeerVolume = Math.max(...peerVolumes);
  return ownVolume > maxPeerVolume || peerVolumes.includes(ownVolume);
}

function isLikelyObsoleteAlternativeEditionSeriesBook(book, currentSeriesAsins, currentItems = [], seriesName = '') {
  if (!book?.asin || currentSeriesAsins.has(book.asin)) return false;
  if (!isAlternativeEditionSeriesItem(book)) return false;
  if (isClearlyDifferentSeriesTitle(book.title, seriesName || book.seriesName)) return false;
  const volume = storedBookVolume(book);
  if (!volume) return false;
  return currentItems.some((item) => seriesItemVolume(item) === volume && !isAlternativeEditionSeriesItem(item));
}

function isAuthoritativeMixedEditionCurrentList(seriesIdentity = {}, series = {}, items = []) {
  if (!isAuthoritativeMixedEditionSeriesIdentity(seriesIdentity)) return false;
  if (!Array.isArray(items) || items.length === 0) return false;

  const expected = Math.max(Number(series.expectedVolumeCount || 0), items.length);
  if (expected > 0 && items.length < expected) return false;

  const volumes = items.map(seriesItemVolume).filter((volume) => Number.isFinite(volume) && volume > 0);
  return isContiguousOneBasedVolumeSet(volumes, items.length);
}

function isAuthoritativeMixedEditionSeriesIdentity(seriesIdentity = {}) {
  const key = String(seriesIdentity.seriesKey || '').trim();
  if (AUTHORITATIVE_MIXED_EDITION_SERIES_KEYS.has(key)) return true;

  const sourceAsin = String(seriesIdentity.sourceAsin || '').toUpperCase();
  return Boolean(sourceAsin && AUTHORITATIVE_MIXED_EDITION_SERIES_KEYS.has(`series:asin:${sourceAsin}`));
}

function isSingleEpisodeLikeTitle(title) {
  const value = String(title || '');
  return /単話|分冊|全\s*[0-9０-９]{1,4}\s*話中第\s*[0-9０-９]{1,4}\s*話|第\s*[0-9０-９]{1,4}\s*話/u.test(value);
}

function isSeriesNavigationPseudoItem(item = {}) {
  return isSeriesNavigationPseudoTitle(item.title);
}

function isNonBookSeriesCandidateItem(item = {}) {
  return isSeriesNavigationPseudoItem(item) || isAmazonRatingOrReviewTitle(item.title);
}

function isSeriesNavigationPseudoTitle(title) {
  const value = String(title || '').normalize('NFKC').trim();
  return (
    /^全\s*[0-9]{1,4}\s*巻中\s*第\s*[0-9]{1,4}\s*巻\s*[:：]/u.test(value) ||
    /^Book\s+[0-9]{1,4}\s+of\s+[0-9]{1,4}\s*[:：]/i.test(value)
  );
}

function isAmazonRatingOrReviewTitle(title) {
  const value = String(title || '').normalize('NFKC').trim();
  return (
    /^5つ星のうち\s*[0-9](?:\.[0-9])?$/u.test(value) ||
    /^[0-9,]+\s*(?:レビュー|ratings?|customer reviews?)$/iu.test(value) ||
    /^カスタマーレビュー$/u.test(value)
  );
}

function seriesGroupKeyForBook(book = {}) {
  return book.seriesKey || book.sourceUrl || '';
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

export function isSupplementalSeriesBookTitle(title, seriesName) {
  const rawTitle = String(title || '').trim();
  const rawSeriesName = String(seriesName || '').trim();
  if (!rawTitle || !rawSeriesName || isGenericSeriesName(rawSeriesName)) return false;
  if (isKnownMixedEditionSeriesTitle(rawTitle, rawSeriesName)) return false;
  if (!seriesTitleContainsSeriesName(rawTitle, rawSeriesName)) return false;

  const normalizedTitle = normalizeSupplementalTitleText(rawTitle);
  const normalizedSeries = normalizeSupplementalTitleText(rawSeriesName);
  for (const pattern of SUPPLEMENTAL_SERIES_TITLE_PATTERNS) {
    if (!pattern.test(normalizedTitle)) continue;
    if (pattern.test(normalizedSeries)) continue;
    return true;
  }
  return false;
}

const SUPPLEMENTAL_SERIES_TITLE_PATTERNS = [
  /公式/u,
  /ガイド|guide/u,
  /ファンブック|fanbook/u,
  /読本/u,
  /名鑑|図鑑|事典|辞典|データブック|character/u,
  /解説|設定資料/u,
  /映画|劇場版|実写/u,
  /外伝|スピンオフ|spinoff|spin-off/u,
  /小説|novel/u,
  /上下巻合計|上下巻|全巻セット|全巻合本|全巻まとめ|まとめ買い|合本/u,
  /感動は終わらない/u,
  /悔いなき選択/u,
  /lost\s*girls/u,
  /before\s*the\s*fall/u,
  /中学校|junior\s*high/u,
  /answers|inside|outside/u
];

function seriesTitleContainsSeriesName(title, seriesName) {
  const titleStem = seriesTitleComparisonStem(title);
  const seriesStem = seriesTitleComparisonStem(seriesName);
  return Boolean(titleStem && seriesStem && titleStem.includes(seriesStem));
}

function normalizeSupplementalTitleText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

export function isClearlyDifferentSeriesTitle(title, seriesName) {
  const rawTitle = String(title || '').trim();
  const rawSeriesName = String(seriesName || '').trim();
  if (!rawTitle || isGenericSeriesName(rawSeriesName)) return false;
  if (/^ASIN\s+[A-Z0-9]{10}$/i.test(rawTitle) || isAmazonErrorPageBookTitle(rawTitle)) return false;
  if (isKnownMixedEditionSeriesTitle(rawTitle, rawSeriesName)) return false;

  const titleStem = seriesTitleComparisonStem(rawTitle);
  const seriesStem = seriesTitleComparisonStem(rawSeriesName);
  const titleCore = seriesTitleComparisonCore(rawTitle);
  const seriesCore = seriesTitleComparisonCore(rawSeriesName);
  if (!titleStem || !seriesStem) return false;
  if (seriesStem.length < 3 || seriesCore.length < 3) {
    if (titleStem === seriesStem || titleCore === seriesCore) return false;
    return Boolean(titleCore && seriesCore && titleCore !== seriesCore);
  }
  if (titleStem.includes(seriesStem) || seriesStem.includes(titleStem)) return false;

  if (!titleCore || !seriesCore || titleCore.length < 3 || seriesCore.length < 3) return false;
  if (titleCore.includes(seriesCore) || seriesCore.includes(titleCore)) return false;
  if (commonPrefixLength(titleCore, seriesCore) >= Math.min(6, titleCore.length, seriesCore.length)) return false;

  return true;
}

function isKnownMixedEditionSeriesTitle(title, seriesName) {
  return String(seriesName || '').trim() === '軍鶏' && /極厚版『?軍鶏』?/u.test(String(title || ''));
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
    .replace(/[（(]\s*(?:上|中|下|前編|後編|完結編)\s*[）)]/gu, ' ')
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
  const titleVolume = volumeFromSeriesTitle(item?.title);
  const explicitVolume = Number(item?.volume) || 0;
  if (
    explicitVolume > 0 &&
    titleVolume > 0 &&
    titleVolume !== explicitVolume &&
    isSeriesDerivedPriceProvider(item?.provider)
  ) {
    return explicitVolume;
  }
  return titleVolume || explicitVolume || 0;
}

function trustedVolumeFromStoredBookTitle(book = {}) {
  return trustedVolumeFromSeriesTitle(book.title, book.seriesName);
}

function trustedVolumeFromSeriesTitle(title, seriesName = '') {
  const value = String(title || '').normalize('NFKC').trim();
  if (!value || isNonBookSeriesCandidateItem({ title: value })) return 0;
  if (/巻之|相当|[0-9０-９]{1,3}\s*[~〜～\-－]\s*[0-9０-９]{1,3}\s*巻/u.test(value)) return 0;

  const seriesStem = seriesTitleComparisonStem(seriesName);
  if (seriesStem && !seriesTitleComparisonStem(value).includes(seriesStem)) return 0;

  const partVolume = volumeFromTerminalPartMarker(value);
  if (partVolume) return partVolume;

  const numericMatch =
    value.match(/(?:第)?([0-9０-９]{1,3})\s*巻/u) ||
    value.match(/[（(]\s*([0-9０-９]{1,3})\s*[）)](?:\s*[（(][^（）()]{0,80}[）)])?\s*$/u) ||
    value.match(/(?:^|[\s　:：\-－ー—])([0-9０-９]{1,3})(?:\s*[）)]|\s*[（(][^（）()]{0,80}[）)]|\s*$)/u);
  if (!numericMatch) return 0;
  return Number(String(numericMatch[1]).replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))) || 0;
}

function volumeFromTerminalPartMarker(title) {
  const value = String(title || '').normalize('NFKC').trim();
  const marker = value.match(/[（(]\s*(上|中|下|前編|後編)\s*[）)]/u)?.[1] ||
    value.match(/(?:^|[\s　:：\-－ー—])(?:第)?(上|中|下|前編|後編)\s*$/u)?.[1];
  if (!marker) return 0;
  if (marker === '上' || marker === '前編') return 1;
  if (marker === '中') return 2;
  if (marker === '下' || marker === '後編') return 2;
  return 0;
}

function volumeFromSeriesTitle(title) {
  const value = String(title || '');
  const match =
    value.match(/(?:第)?([0-9０-９]{1,3})\s*巻/) ||
    value.match(/[（(]\s*([0-9０-９]{1,3})\s*[）)](?:\s*[（(][^（）()]{0,80}[）)])?\s*$/) ||
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
  return checkOneBook(book, { ...options, store });
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
  const maxAsins = floorNumber(options.maxAsins, 1, 30);
  if (requestedAsins.length > maxAsins) {
    const error = new Error(`一度に修復できるASINは${maxAsins}件までです`);
    error.status = 400;
    throw error;
  }

  const now = options.now || new Date().toISOString();
  const currentStore = await readStore();
  const booksByAsin = new Map((currentStore.books || []).map((book) => [book.asin, book]));
  const seriesCandidateCache = options.seriesCandidateCache || new Map();
  const failureBudget = repairFailureBudget(options);
  const fetchStats = {
    processed: 0,
    failed: 0
  };
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
    async (target) => {
      const snapshotResult = await settleSnapshotWithDeadline(
        target.asin,
        target.book,
        repairPriceSnapshotTimeoutMs(options),
        {
          seriesCandidateCache,
          store: currentStore,
          seriesPriceFirst: options.seriesPriceFirst
        }
      );
      if (typeof options.onProgress === 'function') {
        options.onProgress({
          phase: 'fetched',
          asin: target.asin,
          bookId: target.bookId,
          ok: Boolean(snapshotResult.ok),
          error: snapshotResult.ok ? '' : snapshotResult.error || ''
        });
      }
      fetchStats.processed += 1;
      if (!snapshotResult.ok) fetchStats.failed += 1;
      const abortError = repairFailureBudgetAbortError(fetchStats, failureBudget);
      if (abortError) throw abortError;
      return {
        asin: target.asin,
        bookId: target.bookId,
        snapshotResult
      };
    }
  );

  const abortError = repairFailureBudgetAbortError(fetchStats, failureBudget);
  if (abortError) throw abortError;

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

function repairFailureBudget(options = {}) {
  const rate = normalizeFailureRate(options.abortFailureRate);
  if (!rate) return null;
  return {
    rate,
    minimum: floorNumber(options.abortFailureMinimum, 1, 10)
  };
}

function normalizeFailureRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 1) return null;
  return number;
}

function repairFailureBudgetAbortError(stats, budget) {
  if (!budget) return null;
  if (!stats || stats.processed < budget.minimum) return null;

  const failureRate = stats.failed / stats.processed;
  if (failureRate <= budget.rate) return null;

  const error = new Error(
    `価格修復を中断しました: 失敗率${Math.round(failureRate * 100)}%が上限${Math.round(budget.rate * 100)}%を超えています`
  );
  error.status = 503;
  error.code = 'REPAIR_FAILURE_RATE_EXCEEDED';
  error.abortSummary = {
    processed: stats.processed,
    failed: stats.failed,
    failureRate,
    maxFailureRate: budget.rate,
    minimum: budget.minimum
  };
  return error;
}

async function settleSnapshotWithDeadline(asin, book, timeoutMs, options = {}) {
  if (!timeoutMs) return settleSnapshot(asin, book, options);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await settleSnapshot(asin, book, {
      ...options,
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
  let scheduleIntent = null;
  let isBackupRun = false;

  try {
    const startedAt = Date.now();
    const maxRuntimeMs = floorNumber(process.env.CHECK_MAX_RUNTIME_MS, 0, 0);
    const saveReserveMs = runtimeSaveReserveMs();
    const seriesCandidateCache = options.seriesCandidateCache || new Map();
    let store = await readStoreWithPriceRepairs();
    const baseStore = cloneBulkStoreSnapshot(store);
    let settings = mergedRuntimeSettings(store.settings);
    scheduleIntent = resolveCronScheduleIntent(options.scheduleCron || process.env.CHECK_SCHEDULE_CRON, startedAt);
    const forceAll = options.force === true || readEnvBoolean('FORCE_CHECK_ALL', false);
    isBackupRun = source === 'cron' && (options.backup === true || scheduleIntent?.backup === true);
    const scheduleNow = scheduleIntent?.executionBoundaryMs || startedAt;

    if (!forceAll && source === 'cron' && scheduleIntent?.stale) {
      return {
        checked: 0,
        remainingDue: countDueBooks(store.books, startedAt),
        cursor: store.checkCursor,
        overlapped: 0,
        stoppedByRuntimeLimit: false,
        forced: false,
        backup: isBackupRun,
        skipped: true,
        skipReason: 'stale_schedule',
        scheduledCron: scheduleIntent.scheduleCron,
        scheduledNominalAt: scheduleIntent.nominalAt,
        executionBoundaryAt: scheduleIntent.executionBoundaryAt,
        nextExecutionBoundaryAt: scheduleIntent.nextExecutionBoundaryAt,
        seriesDiscovery: null,
        results: []
      };
    }

    if (!forceAll && shouldWaitForScheduledExecutionWindow(source, { ...options, scheduleIntent }, startedAt)) {
      const remainingDue = countDueBooks(store.books, startedAt);
      const nextRunAtMs = nextJstExecutionBoundaryMs(startedAt);
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

    if (!forceAll && source === 'cron' && scheduleIntent) {
      const completionSkip = cronWindowCompletionState(store.automation, scheduleIntent.executionBoundaryMs);
      if (completionSkip.shouldSkip) {
        return {
          checked: 0,
          remainingDue: countDueBooks(store.books, scheduleIntent.executionBoundaryMs),
          cursor: store.checkCursor,
          overlapped: 0,
          stoppedByRuntimeLimit: false,
          forced: false,
          backup: isBackupRun,
          skipped: true,
          skipReason: isBackupRun ? 'primary_cron_completed' : 'cron_window_completed',
          skipDetail: completionSkip.skipDetail,
          scheduledCron: scheduleIntent.scheduleCron,
          scheduledNominalAt: scheduleIntent.nominalAt,
          executionBoundaryAt: completionSkip.executionBoundaryAt,
          lastCronExecutionBoundaryAt: completionSkip.lastCronExecutionBoundaryAt,
          lastCronStartedAt: completionSkip.lastCronStartedAt,
          lastCronFinishedAt: completionSkip.lastCronFinishedAt,
          lastCronStoppedByRuntimeLimit: completionSkip.lastCronStoppedByRuntimeLimit,
          lastCronError: completionSkip.lastCronError,
          seriesDiscovery: null,
          results: []
        };
      }
    } else if (!forceAll && isBackupRun) {
      const backupSkip = backupCronSkipState(store.automation, startedAt);
      if (backupSkip.shouldSkip) {
        return {
          checked: 0,
          remainingDue: countDueBooks(store.books, startedAt),
          cursor: store.checkCursor,
          overlapped: 0,
          stoppedByRuntimeLimit: false,
          forced: false,
          backup: true,
          skipped: true,
          skipReason: 'primary_cron_completed',
          skipDetail: backupSkip.skipDetail,
          executionBoundaryAt: backupSkip.executionBoundaryAt,
          lastCronExecutionBoundaryAt: backupSkip.lastCronExecutionBoundaryAt,
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
      ? await processBookImportQueueInStore(store, { startedAt, maxRuntimeMs, saveReserveMs, now: cronStartedAt, seriesCandidateCache })
      : null;
    let seriesDiscovery = shouldRunSeriesDiscovery(source, options, store, settings, startedAt)
      ? await discoverSeriesUpdates(store, { startedAt, maxRuntimeMs, saveReserveMs, seriesCandidateCache })
      : null;
    const discoveredSeriesKeys = seriesDiscoveryKeys(seriesDiscovery);
    const discoverCheckedSeries = shouldRunCheckedBookSeriesDiscovery(source, options);
    settings = mergedRuntimeSettings(store.settings);
    const plan = planDueChecks(store, settings, startedAt, {
      forceAll,
      dueCutoffMs: scheduleIntent?.executionBoundaryMs
    });
    const pacing = checkPacing();
    const getWebhookUrls = options.notify === false ? null : sharedWebhookUrlLoader();
    const seriesNotificationBaselines = new Map();
    const seriesFreshAfter = seriesAggregateFreshAfter(scheduleNow).toISOString();

    const results = [];
    let stoppedByRuntimeLimit = false;
    const processedBookIds = new Set();
    const cachedSeriesRetryCandidates = [];
    let transientErrorStreak = 0;
    for (let index = 0; index < plan.books.length; index += 1) {
      if (shouldStopBeforeNextBookCheck(startedAt, maxRuntimeMs, saveReserveMs)) {
        stoppedByRuntimeLimit = true;
        break;
      }

      const book = plan.books[index];
      const canUseCachedSeriesPrice = canUseCachedSeriesPriceSnapshotForBook(book, {
        seriesCandidateCache,
        store
      });
      if (
        !canUseCachedSeriesPrice &&
        !(await waitBeforeCheck(pacing, results.length, startedAt, maxRuntimeMs, saveReserveMs))
      ) {
        stoppedByRuntimeLimit = true;
        break;
      }

      if (shouldStopBeforeNextBookCheck(startedAt, maxRuntimeMs, saveReserveMs)) {
        stoppedByRuntimeLimit = true;
        break;
      }

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
          seriesFreshAfter,
          seriesCandidateCache
        });
      } finally {
        runtime.cleanup();
      }
      results.push(result);
      processedBookIds.add(book.id);
      if (shouldRetryCheckWithCachedSeriesPrice(book, result)) {
        cachedSeriesRetryCandidates.push({
          index: results.length - 1,
          bookId: book.id,
          originalError: checkResultErrorMessage(result)
        });
      }

      if (discoverCheckedSeries) {
        if (shouldStopBeforeSeriesDiscovery(startedAt, maxRuntimeMs, saveReserveMs)) {
          stoppedByRuntimeLimit = true;
          break;
        }
        const checkedSeriesDiscovery = await discoverSeriesUpdateForCheckedBook(store, result.book, {
          startedAt,
          maxRuntimeMs,
          saveReserveMs,
          seenKeys: discoveredSeriesKeys,
          seriesCandidateCache
        });
        if (checkedSeriesDiscovery) {
          seriesDiscovery = mergeSeriesDiscoverySummaries(seriesDiscovery, checkedSeriesDiscovery);
          for (const key of seriesDiscoveryKeys(checkedSeriesDiscovery)) discoveredSeriesKeys.add(key);
          if (checkedSeriesDiscovery.stoppedByRuntimeLimit) {
            stoppedByRuntimeLimit = true;
            break;
          }
        }
      }

      if (isBlockingCheckResult(result)) {
        transientErrorStreak = 0;
        if (!(await waitAfterBlockedCheck(pacing, startedAt, maxRuntimeMs, saveReserveMs))) {
          stoppedByRuntimeLimit = true;
          break;
        }
      } else if (isTransientCheckResult(result)) {
        transientErrorStreak += 1;
        if (shouldCooldownAfterTransientErrorStreak(pacing, transientErrorStreak)) {
          transientErrorStreak = 0;
          if (!(await waitAfterTransientErrorChecks(pacing, startedAt, maxRuntimeMs, saveReserveMs))) {
            stoppedByRuntimeLimit = true;
            break;
          }
        }
      } else {
        transientErrorStreak = 0;
      }

      if (shouldStopBeforeNextBookCheck(startedAt, maxRuntimeMs, saveReserveMs)) {
        stoppedByRuntimeLimit = true;
        break;
      }
    }

    const cachedSeriesRetries = await retryCachedSeriesCheckFailuresInStore(store, cachedSeriesRetryCandidates, {
      ...options,
      getWebhookUrls,
      deferSeriesNotifications: true,
      seriesNotificationBaselines,
      seriesFreshAfter,
      seriesCandidateCache
    });
    for (const retry of cachedSeriesRetries) {
      results[retry.index] = retry.result;
    }

    const listPriceChallenge = shouldRunListPriceChallenge(source, options)
      ? await runListPriceChallengeInStore(store, results, {
          startedAt,
          maxRuntimeMs,
          saveReserveMs,
          settings,
          pacing
        })
      : null;

    const priceIntegrityAudit = shouldRunPriceIntegrityAudit(source, options)
      ? await runPriceIntegrityAudit(store, results, {
          ...options,
          startedAt,
          maxRuntimeMs,
          saveReserveMs,
          now: new Date().toISOString(),
          seriesCandidateCache
        })
      : null;

    const checkErrorSummary = summarizeCheckResultErrors(results);
    const seriesNotifications = await sendDeferredSeriesNotifications(store, seriesNotificationBaselines, {
      ...options,
      getWebhookUrls
    });
    const remainingDue = countDueBooks(store.books, scheduleNow);
    const finishedAt = new Date().toISOString();
    const seriesDiscoveryAdditions = seriesDiscoveryAdditionsForAutomation(store, seriesDiscovery);
    const persistedSeriesDiscovery = seriesDiscovery
      ? {
          ...seriesDiscovery,
          added: seriesDiscoveryAdditions.length,
          additions: seriesDiscoveryAdditions
        }
      : seriesDiscovery;
    const result = {
      checked: results.length,
      remainingDue,
      cursor: store.checkCursor,
      overlapped: Math.max(0, results.length - plan.dueSelected),
      stoppedByRuntimeLimit,
      forced: forceAll,
      backup: isBackupRun,
      scheduledCron: scheduleIntent?.scheduleCron || '',
      scheduledNominalAt: scheduleIntent?.nominalAt || '',
      executionBoundaryAt: scheduleIntent?.executionBoundaryAt || '',
      importQueue,
      seriesDiscovery: persistedSeriesDiscovery,
      listPriceChallenge,
      priceIntegrityAudit,
      checkErrorSummary,
      seriesNotifications,
      results
    };

    const cronFields = source === 'cron' && shouldPersistCronRun(result)
      ? {
          lastCronStartedAt: cronStartedAt,
          lastCronFinishedAt: finishedAt,
          ...(scheduleIntent
            ? {
                lastCronExecutionBoundaryAt: scheduleIntent.executionBoundaryAt,
                lastCronSchedule: scheduleIntent.scheduleCron
              }
            : {}),
          lastCronBackup: isBackupRun,
          lastCronChecked: result.checked,
          lastCronRemainingDue: result.remainingDue,
          lastCronStoppedByRuntimeLimit: result.stoppedByRuntimeLimit,
          lastCronResultErrors: checkErrorSummary.total,
          lastCronErrorBreakdown: checkErrorSummary.breakdown,
          lastCronErrorSamples: checkErrorSummary.samples,
          lastImportQueueProcessed: importQueue?.processed || 0,
          lastImportQueueImported: importQueue?.imported || 0,
          lastImportQueueErrors: importQueue?.errors?.length || 0,
          lastSeriesDiscoveryChecked: persistedSeriesDiscovery?.checked || 0,
          lastSeriesDiscoveryAdded: persistedSeriesDiscovery?.added || 0,
          lastSeriesDiscoveryAdditions: persistedSeriesDiscovery?.additions || [],
          lastSeriesDiscoveryCompleted: persistedSeriesDiscovery?.completed || 0,
          lastSeriesDiscoverySkipped: persistedSeriesDiscovery?.skippedNoRun || 0,
          lastSeriesDiscoveryDeferred: persistedSeriesDiscovery?.deferred || 0,
          lastSeriesDiscoveryErrors: persistedSeriesDiscovery?.errors?.length || 0,
          lastListPriceChallengeEligible: listPriceChallenge?.eligible || 0,
          lastListPriceChallengeAttempted: listPriceChallenge?.attempted || 0,
          lastListPriceChallengeUpdated: listPriceChallenge?.updated || 0,
          lastListPriceChallengeObservedFallback: listPriceChallenge?.observedFallback || 0,
          lastListPriceChallengePeerFallback: listPriceChallenge?.peerFallback || 0,
          lastListPriceChallengeNotFound: listPriceChallenge?.notFound || 0,
          lastListPriceChallengeRejected: listPriceChallenge?.rejected || 0,
          lastListPriceChallengeErrors: listPriceChallenge?.errors?.length || 0,
          lastListPriceChallengeSkippedRecentNotFound: listPriceChallenge?.skippedRecentNotFound || 0,
          lastListPriceChallengeNotFoundSamples: listPriceChallenge?.notFoundSamples || [],
          lastListPriceChallengeStoppedByRuntimeLimit: Boolean(listPriceChallenge?.stoppedByRuntimeLimit),
          lastPriceIntegrityAuditChecked: priceIntegrityAudit?.checked || 0,
          lastPriceIntegrityAuditSuspicious: priceIntegrityAudit?.suspicious || 0,
          lastPriceIntegrityAuditWarnings: priceIntegrityAudit?.warnings || 0,
          lastPriceIntegrityAuditRepaired: priceIntegrityAudit?.repaired || 0,
          lastPriceIntegrityAuditUnresolved: priceIntegrityAudit?.unresolved || 0,
          lastPriceIntegrityAuditFindings: priceIntegrityAudit?.findings || [],
          lastCronError: ''
        }
      : null;

    if (
      processedBookIds.size > 0 ||
      cronFields ||
      hasSeriesDiscoveryWork(persistedSeriesDiscovery) ||
      hasImportQueueWork(importQueue) ||
      hasListPriceChallengeWork(listPriceChallenge)
    ) {
      await persistBulkCheckStore({
        store,
        baseStore,
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
        ...(scheduleIntent
          ? {
              lastCronExecutionBoundaryAt: scheduleIntent.executionBoundaryAt,
              lastCronSchedule: scheduleIntent.scheduleCron
            }
          : {}),
        lastCronBackup: isBackupRun,
        lastCronStoppedByRuntimeLimit: false,
        lastCronError: error.message || String(error)
      });
    }
    throw error;
  }
}

export function summarizeCheckResultErrors(results = []) {
  const buckets = new Map();
  const samples = [];

  for (const entry of results || []) {
    if (entry?.ok !== false && !entry?.error) continue;
    const error = checkResultErrorMessage(entry);
    if (!error) continue;
    const reason = normalizeCheckErrorReason(error);
    const current = buckets.get(reason) || { reason, count: 0 };
    current.count += 1;
    buckets.set(reason, current);

    if (samples.length < 10) {
      samples.push({
        asin: entry?.book?.asin || '',
        title: entry?.book?.title || '',
        seriesName: entry?.book?.seriesName || '',
        volume: entry?.book?.volume || '',
        reason,
        error: truncateSummaryText(error, 120)
      });
    }
  }

  const breakdown = [...buckets.values()]
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason, 'ja'))
    .slice(0, 10);

  return {
    total: [...buckets.values()].reduce((sum, entry) => sum + entry.count, 0),
    breakdown,
    samples
  };
}

function checkResultErrorMessage(entry = {}) {
  return String(entry.error || entry.book?.lastError || '').trim();
}

function normalizeCheckErrorReason(error = '') {
  const text = String(error || '').replace(/\s+/g, ' ').trim();
  if (!text) return '不明な取得エラー';
  if (isBlockingSnapshotError(text)) return 'Amazonブロック/HTTP制限';
  if (/タイムアウト|aborted|AbortError/i.test(text)) return 'タイムアウト';
  if (/価格を取得できませんでした/.test(text)) return '価格を取得できませんでした';
  if (/疑わしい価格を無視しました/.test(text)) return '疑わしい価格を無視しました';
  if (/商品ページではなくエラーページ|エラーページを返しました/.test(text)) return 'Amazonエラーページ';
  if (/Kindle版(?:ASIN|商品)ではありません/.test(text)) return 'Kindle版ではありません';
  return truncateSummaryText(text, 80);
}

function truncateSummaryText(value = '', limit = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function shouldRunPriceIntegrityAudit(source, options = {}) {
  if (options.priceIntegrityAudit === false) return false;
  if (options.priceIntegrityAudit === true) return true;
  if (readEnvBoolean('PRICE_INTEGRITY_AUDIT_ENABLED', true) === false) return false;
  return source === 'cron';
}

async function runPriceIntegrityAudit(store, results = [], options = {}) {
  const now = options.now || new Date().toISOString();
  const targetBooks = priceIntegrityAuditTargets(store, results);
  const summary = {
    checked: targetBooks.length,
    suspicious: 0,
    warnings: 0,
    rechecked: 0,
    repaired: 0,
    unresolved: 0,
    skipped: 0,
    changed: false,
    findings: []
  };
  if (targetBooks.length === 0) return summary;

  const recheckLimit = floorNumber(process.env.PRICE_INTEGRITY_AUDIT_RECHECK_LIMIT, 0, 8);
  for (const book of targetBooks) {
    const issue = priceIntegrityIssueForBook(book, store);
    if (!issue) continue;

    summary[issue.severity === 'warning' ? 'warnings' : 'suspicious'] += 1;
    const finding = priceIntegrityFinding(book, issue);
    summary.findings.push(finding);

    if (issue.severity === 'warning') {
      continue;
    }

    const before = priceStateForComparison(book);
    const repair = repairSuspiciousPriceState(book, store, {
      clearCurrent: true,
      restoreMissingCurrent: true,
      clearStaleDiscountedCurrent: true
    });
    if (repair.changed) summary.changed = true;

    if (
      summary.rechecked < recheckLimit &&
      !shouldStopForRuntimeLimit(options.startedAt, options.maxRuntimeMs, summary.rechecked, options.saveReserveMs)
    ) {
      summary.rechecked += 1;
      const runtime = runtimeAbortOptions(options.startedAt, options.maxRuntimeMs, {
        reserveMs: options.saveReserveMs,
        capMs: priceIntegrityAuditSnapshotTimeoutMs()
      });
      let snapshotResult;
      try {
        snapshotResult = await settleSnapshot(book.asin, book, {
          signal: runtime.signal,
          timeoutMs: priceIntegrityAuditSnapshotTimeoutMs(),
          seriesCandidateCache: options.seriesCandidateCache
        });
      } finally {
        runtime.cleanup();
      }
      const applied = applyCheckResultToStore(store, { id: book.id, asin: book.asin }, snapshotResult, now, {
        updateCursor: false,
        recordNotifications: false
      });
      if (applied.checkedBook) Object.assign(book, store.books.find((item) => item.id === book.id) || book);
    } else {
      summary.skipped += 1;
    }

    const after = priceStateForComparison(book);
    const afterIssue = priceIntegrityIssueForBook(book, store);
    if (JSON.stringify(before) !== JSON.stringify(after)) summary.changed = true;
    if (afterIssue) {
      summary.unresolved += 1;
      finding.unresolved = true;
      finding.afterReason = afterIssue.reason;
    } else {
      summary.repaired += 1;
    }
  }

  summary.findings = summary.findings.slice(0, 10);
  return summary;
}

function priceIntegrityAuditTargets(store, results = []) {
  const ids = new Set(
    (results || [])
      .map((entry) => entry?.book?.id)
      .filter(Boolean)
  );
  return (store.books || []).filter((book) => ids.has(book.id));
}

export function priceIntegrityIssueForBook(book, store) {
  const strictReason = suspiciousStoredCurrentPriceReason(book);
  if (strictReason) {
    return {
      severity: 'suspicious',
      reason: strictReason
    };
  }

  const outlierReason = seriesPriceOutlierReason(book, store);
  if (outlierReason) {
    return {
      severity: 'warning',
      reason: outlierReason
    };
  }

  return null;
}

function priceIntegrityFinding(book, issue) {
  return {
    asin: book.asin,
    title: book.title || '',
    seriesName: book.seriesName || '',
    volume: book.volume || '',
    price: book.currentPrice ?? null,
    points: book.currentPoints ?? 0,
    effectivePrice: book.effectivePrice ?? null,
    provider: book.provider || '',
    severity: issue.severity,
    reason: issue.reason
  };
}

function seriesPriceOutlierReason(book, store) {
  const current = nullableNumber(book.effectivePrice ?? book.currentPrice);
  if (current == null || current <= 0) return '';
  if (!book.seriesKey && !book.sourceUrl) return '';

  const peerPrices = seriesPeerEffectivePrices(book, store);
  if (peerPrices.length < 3) return '';
  const median = medianNumber(peerPrices);
  if (!Number.isFinite(median) || median <= 0) return '';
  if (current > median * PRICE_INTEGRITY_SERIES_OUTLIER_RATIO) return '';
  if (trustedSeriesOutlierProvider(book)) return '';
  return `シリーズ中央値 ${Math.round(median).toLocaleString('ja-JP')}円に対して低すぎます`;
}

function seriesPeerEffectivePrices(book, store) {
  return (store.books || [])
    .filter((item) => item.id !== book.id)
    .filter((item) => isSamePriceIntegritySeries(book, item))
    .map((item) => nullableNumber(item.effectivePrice ?? item.currentPrice))
    .filter((value) => value != null && value > 0);
}

function isSamePriceIntegritySeries(left, right) {
  if (!left || !right) return false;
  if (left.seriesKey && right.seriesKey && left.seriesKey === right.seriesKey) return true;
  return Boolean(left.sourceUrl && right.sourceUrl && left.sourceUrl === right.sourceUrl);
}

function trustedSeriesOutlierProvider(book = {}) {
  const normalized = String(book.provider || '').toLowerCase();
  if (normalized === 'amazon_html') {
    if (book.explicitPriceDisplay || book.explicitFreeKindlePrice) return true;
    const price = nullableNumber(book.currentPrice);
    const effective = nullableNumber(book.effectivePrice ?? book.currentPrice);
    const points = nullableNumber(book.currentPoints) || 0;
    if (price != null && effective != null && price >= 100 && effective >= 100 && points <= price * 0.2) {
      return true;
    }
  }
  return ['amazon_series_child', 'amazon_series_bulk', 'keepa'].includes(normalized);
}

function priceIntegrityAuditSnapshotTimeoutMs() {
  return floorNumber(process.env.PRICE_INTEGRITY_AUDIT_SNAPSHOT_TIMEOUT_MS, 1000, 20000);
}

async function discoverSeriesUpdates(store, options = {}) {
  const now = new Date().toISOString();
  const plan = planSeriesDiscovery(store, { now });
  return runSeriesDiscoveryPlan(store, plan, { ...options, now });
}

async function discoverSeriesUpdateForCheckedBook(store, checkedBook, options = {}) {
  const group = seriesDiscoveryGroupForBook(store, checkedBook);
  if (!group) return null;

  const key = seriesDiscoveryGroupKey(group);
  if (key && options.seenKeys?.has?.(key)) return null;

  const now = new Date().toISOString();
  const plan = planSeriesDiscoveryForGroups(store, [group], { now });
  if (plan.groups.length === 0 && plan.skippedCompleted === 0 && plan.markedNoRun === 0) return null;
  const summary = await runSeriesDiscoveryPlan(store, plan, { ...options, now });
  return {
    ...summary,
    targetKeys: [key].filter(Boolean)
  };
}

async function runSeriesDiscoveryPlan(store, plan, options = {}) {
  const now = options.now || new Date().toISOString();
  const pacing = seriesDiscoveryPacing();
  const saveReserveMs = Number(options.saveReserveMs || 0);
  const results = [];
  const errors = [];
  const deferredEntries = [];
  let added = 0;
  let completed = 0;
  const skippedNoRun = Number(plan.skippedNoRun || 0);
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

      const runtime = runtimeAbortOptions(options.startedAt, options.maxRuntimeMs, {
        reserveMs: saveReserveMs,
        capMs: importItemMaxRuntimeMs()
      });
      let result;
      try {
        result = await addSeriesBooksFromInputInStore(store, seriesDiscoveryInput(group.sourceUrl, group.seriesKey), {
          now,
          signal: runtime.signal,
          seriesCandidateCache: options.seriesCandidateCache,
          expectedSeriesName: group.seriesName
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
        sourceUrl: group.sourceUrl,
        seriesName: group.seriesName,
        checked: true,
        added: newBooks,
        additions: compactSeriesDiscoveryAdditions(result.books || []),
        completed: seriesCompleted
      });
      recordSeriesDiscoveryCursorInStore(store, group, now);
    } catch (error) {
      const message = error.message || String(error);
      const deferReason = seriesDiscoveryDeferReason(group, message);
      if (deferReason) {
        deferredEntries.push({
          seriesKey: group.seriesKey,
          sourceUrl: group.sourceUrl,
          seriesName: group.seriesName,
          reason: deferReason,
          error: message
        });
        markSeriesDiscoveryDeferredInStore(store, group, now, deferReason);
        recordSeriesDiscoveryCursorInStore(store, group, now);
        continue;
      }
      errors.push({
        seriesKey: group.seriesKey,
        sourceUrl: group.sourceUrl,
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
    skippedNoRun,
    skippedCompleted: plan.skippedCompleted,
    markedNoRun: plan.markedNoRun,
    deferred: deferredEntries.length,
    deferredEntries,
    stoppedByRuntimeLimit,
    cursor: store.seriesDiscoveryCursor,
    results,
    errors
  };
}

function seriesDiscoveryAdditionsForAutomation(store, seriesDiscovery = null) {
  const orderedAsins = [];
  const seen = new Set();
  for (const entry of seriesDiscovery?.results || []) {
    for (const book of entry.additions || entry.books || []) {
      const asin = String(book?.asin || '').trim();
      if (!asin || seen.has(asin)) continue;
      seen.add(asin);
      orderedAsins.push(asin);
    }
  }
  if (orderedAsins.length === 0) return [];

  const booksByAsin = new Map((store.books || []).map((book) => [book.asin, book]));
  return compactSeriesDiscoveryAdditions(orderedAsins.map((asin) => booksByAsin.get(asin)).filter(Boolean));
}

function compactSeriesDiscoveryAdditions(books = []) {
  return books
    .filter((book) => book && (book.id || book.asin))
    .slice(0, 50)
    .map((book) => ({
      id: book.id ? String(book.id) : '',
      asin: book.asin ? String(book.asin) : '',
      title: truncateSummaryText(book.title || '', 120),
      seriesName: truncateSummaryText(book.seriesName || '', 120),
      sourceUrl: book.sourceUrl ? String(book.sourceUrl) : '',
      createdAt: book.createdAt || '',
      seriesLastDiscoveredAt: book.seriesLastDiscoveredAt || ''
    }));
}

function mergeSeriesDiscoverySummaries(base, next) {
  if (!base) return next || null;
  if (!next) return base;

  return {
    checked: Number(base.checked || 0) + Number(next.checked || 0),
    added: Number(base.added || 0) + Number(next.added || 0),
    completed: Number(base.completed || 0) + Number(next.completed || 0),
    skippedNoRun: Number(base.skippedNoRun || 0) + Number(next.skippedNoRun || 0),
    skippedCompleted: Number(base.skippedCompleted || 0) + Number(next.skippedCompleted || 0),
    markedNoRun: Number(base.markedNoRun || 0) + Number(next.markedNoRun || 0),
    deferred: Number(base.deferred || 0) + Number(next.deferred || 0),
    stoppedByRuntimeLimit: Boolean(base.stoppedByRuntimeLimit || next.stoppedByRuntimeLimit),
    cursor: next.cursor || base.cursor,
    targetKeys: [...new Set([...(base.targetKeys || []), ...(next.targetKeys || [])])],
    results: [...(base.results || []), ...(next.results || [])],
    deferredEntries: [...(base.deferredEntries || []), ...(next.deferredEntries || [])],
    errors: [...(base.errors || []), ...(next.errors || [])]
  };
}

function seriesDiscoveryKeys(seriesDiscovery = null) {
  const keys = new Set();
  for (const key of seriesDiscovery?.targetKeys || []) {
    if (key) keys.add(key);
  }
  for (const entry of seriesDiscovery?.results || []) {
    const key = entry.seriesKey || entry.sourceUrl || '';
    if (key) keys.add(key);
  }
  for (const entry of seriesDiscovery?.deferredEntries || []) {
    const key = entry.seriesKey || entry.sourceUrl || '';
    if (key) keys.add(key);
  }
  for (const entry of seriesDiscovery?.errors || []) {
    const key = entry.seriesKey || entry.sourceUrl || '';
    if (key) keys.add(key);
  }
  return keys;
}

function shouldRunSeriesDiscovery(source, options = {}, store = {}, settings = {}, now = Date.now()) {
  if (options.discoverSeries === true) return true;
  if (options.discoverSeries === false) return false;
  if (source !== 'cron') return false;

  const intervalHours = floorNumber(process.env.SERIES_DISCOVERY_INTERVAL_HOURS, 1, 24);
  const intervalDays = Math.max(1, Math.round(intervalHours / 24));
  const lastCheckedAt = new Date(store.seriesDiscoveryCursor?.checkedAt || 0).getTime();
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) return true;

  const boundary = latestJstExecutionBoundaryMs(now);
  const lastBoundary = latestJstExecutionBoundaryMs(lastCheckedAt);
  return boundary - lastBoundary >= intervalDays * 24 * 60 * 60 * 1000;
}

function shouldRunCheckedBookSeriesDiscovery(source, options = {}) {
  if (options.discoverCheckedSeries === true) return true;
  if (options.discoverCheckedSeries === false || options.discoverSeries === false) return false;
  return source === 'cron';
}

function shouldRunBookImportQueue(source, options = {}) {
  if (options.importQueue === true) return true;
  if (options.importQueue === false) return false;
  return source === 'cron';
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
        result = await addBooksFromInputInStore(store, input, {
          now,
          signal: runtime.signal,
          seriesCandidateCache: options.seriesCandidateCache
        });
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
  const blockedGroups = allGroups.filter(isBlockedSeriesDiscoveryGroup);
  const completedGroups = allGroups.filter((group) => group.completed);
  const completedRecheckGroups = completedGroups.filter((group) => shouldRecheckCompletedSeriesGroup(group, options.now));
  const completedNoRunGroups = completedGroups.filter((group) => !completedRecheckGroups.includes(group));
  const markedNoRun = markNoRunSeriesDiscoveryGroups(store, completedNoRunGroups, {
    now: options.now,
    reason: 'completed'
  });
  const groups = rotateSeriesGroupsAfterCursor(
    [
      ...allGroups.filter((group) => !group.completed && !blockedGroups.includes(group)),
      ...completedRecheckGroups.filter((group) => !blockedGroups.includes(group))
    ],
    store.seriesDiscoveryCursor?.lastSeriesKey
  );
  const limit = floorNumber(process.env.SERIES_DISCOVERY_BATCH_SIZE, 1, 50);
  return {
    groups: groups.slice(0, limit),
    totalEligible: groups.length,
    skippedCompleted: completedNoRunGroups.length,
    skippedNoRun: completedNoRunGroups.length + blockedGroups.length,
    markedNoRun
  };
}

function planSeriesDiscoveryForGroups(store, groups, options = {}) {
  const uniqueGroups = uniqueSeriesDiscoveryGroups(groups);
  const blockedGroups = uniqueGroups.filter(isBlockedSeriesDiscoveryGroup);
  const completedGroups = uniqueGroups.filter((group) => group.completed);
  const completedRecheckGroups = completedGroups.filter((group) => shouldRecheckCompletedSeriesGroup(group, options.now));
  const completedNoRunGroups = completedGroups.filter((group) => !completedRecheckGroups.includes(group));
  const markedNoRun = markNoRunSeriesDiscoveryGroups(store, completedNoRunGroups, {
    now: options.now,
    reason: 'completed'
  });
  const limit = floorNumber(
    process.env.SERIES_DISCOVERY_PER_CHECK_BATCH_SIZE ?? process.env.SERIES_DISCOVERY_BATCH_SIZE,
    1,
    50
  );
  const runnableGroups = [
    ...uniqueGroups.filter((group) => !group.completed && !blockedGroups.includes(group)),
    ...completedRecheckGroups.filter((group) => !blockedGroups.includes(group))
  ].slice(0, limit);
  return {
    groups: runnableGroups,
    totalEligible: runnableGroups.length,
    skippedCompleted: completedNoRunGroups.length,
    skippedNoRun: completedNoRunGroups.length + blockedGroups.length,
    markedNoRun
  };
}

function isBlockedSeriesDiscoveryGroup(group = {}) {
  const books = Array.isArray(group.books) ? group.books : [];
  if (books.length === 0) return false;
  return books.every(
    (book) =>
      book.seriesDiscoveryStatus === 'deferred' &&
      ['source_mismatch', 'source_unavailable'].includes(String(book.seriesDiscoverySkipReason || ''))
  );
}

export function shouldRecheckCompletedSeriesGroup(group = {}, now = new Date().toISOString()) {
  if (!group.completed) return false;
  const intervalDays = floorNumber(process.env.SERIES_COMPLETED_RECHECK_DAYS, 1, 7);
  const nowMs = new Date(now || Date.now()).getTime();
  if (!Number.isFinite(nowMs)) return false;

  const checkedTimes = (group.books || [])
    .flatMap((book) => [book.seriesCompletedAt, book.seriesLastDiscoveredAt])
    .map((value) => new Date(value || 0).getTime())
    .filter((value) => Number.isFinite(value) && value > 0);
  if (checkedTimes.length === 0) return true;

  return nowMs - Math.max(...checkedTimes) >= intervalDays * DAY_MS;
}

function seriesDiscoveryGroupForBook(store, checkedBook) {
  if (!checkedBook?.id && !checkedBook?.asin) return null;
  const groups = seriesDiscoveryGroups(store.books);
  return groups.find((group) => group.books.some((book) => sameBookIdentity(book, checkedBook))) || null;
}

function uniqueSeriesDiscoveryGroups(groups = []) {
  const unique = new Map();
  for (const group of groups) {
    const key = seriesDiscoveryGroupKey(group);
    if (!key || unique.has(key)) continue;
    unique.set(key, group);
  }
  return [...unique.values()];
}

function seriesDiscoveryGroupKey(group = {}) {
  return group.seriesKey || group.sourceUrl || '';
}

function sameBookIdentity(left = {}, right = {}) {
  if (left.id && right.id && left.id === right.id) return true;
  return Boolean(left.asin && right.asin && left.asin === right.asin);
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

function seriesDiscoveryDeferReason(group, error) {
  const message = String(error || '');
  if (/シリーズ探索結果が別作品の可能性があります/.test(message)) return 'source_mismatch';
  if (/シリーズ内のKindle ASINを取得できませんでした/.test(message) && hasCompleteKnownSeriesCoverage(group)) {
    return 'source_unavailable';
  }
  return '';
}

export function seriesDiscoveryResultMismatchReason(expectedSeriesName = '', series = {}) {
  const expected = cleanStoredSeriesName(expectedSeriesName || '');
  const actual = cleanStoredSeriesName(series?.seriesName || '');
  if (!expected || isGenericSeriesName(expected)) return '';
  if (!actual || isGenericSeriesName(actual)) return '';

  const items = Array.isArray(series?.items) ? series.items : [];
  const comparableItems = items.filter((item) => String(item?.title || '').trim());
  const differentItems = comparableItems.filter((item) => isClearlyDifferentSeriesTitle(item.title, expected));
  const matchingItems = comparableItems.filter((item) => !isClearlyDifferentSeriesTitle(item.title, expected));
  const actualDiffers = isClearlyDifferentSeriesTitle(actual, expected);
  const itemMajorityDiffers =
    comparableItems.length >= 3 &&
    differentItems.length >= Math.ceil(comparableItems.length * 0.8) &&
    differentItems.length > matchingItems.length;
  const allItemsDiffer = comparableItems.length >= 2 && differentItems.length === comparableItems.length;
  const itemEvidenceDiffers = itemMajorityDiffers || allItemsDiffer;

  if (!actualDiffers && !itemEvidenceDiffers) return '';
  if (actualDiffers && comparableItems.length > 0 && !itemEvidenceDiffers) return '';

  return `シリーズ探索結果が別作品の可能性があります: expected "${expected}", got "${actual}"`;
}

function hasCompleteKnownSeriesCoverage(group = {}) {
  const books = Array.isArray(group.books) ? group.books : [];
  if (books.length < 2) return false;
  const expected = Math.max(...books.map((book) => Number(book.seriesExpectedCount || 0)).filter((value) => value > 0), 0);
  const volumes = new Set(books.map((book) => Number(book.volume || 0)).filter((value) => value > 0));
  const maxVolume = volumes.size > 0 ? Math.max(...volumes) : 0;
  if (maxVolume < 2) return false;
  for (let volume = 1; volume <= maxVolume; volume += 1) {
    if (!volumes.has(volume)) return false;
  }
  const knownCount = Math.max(books.length, volumes.size);
  if (expected > 0) return knownCount >= expected && maxVolume >= expected;
  return knownCount >= maxVolume;
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
  return asin ? kindleSeriesFetchUrlForAsin(asin.toUpperCase()) : sourceUrl;
}

function seriesTitleFromBook(book) {
  return cleanStoredSeriesName(book.seriesName || book.title || 'Kindle シリーズ');
}

function shouldStopSeriesDiscoveryForRuntimeLimit(startedAt, maxRuntimeMs, completedCount, reserveMs = 0) {
  return (
    shouldStopForRuntimeLimit(startedAt, maxRuntimeMs, completedCount, reserveMs) ||
    shouldStopBeforeSeriesDiscovery(startedAt, maxRuntimeMs, reserveMs)
  );
}

function markSeriesDiscoveryErrorInStore(store, group, now, error) {
  for (const book of store.books) {
    if (!bookBelongsToSeriesDiscoveryGroup(book, group)) continue;
    applySeriesDiscoveryMetadata(book, { now, error });
  }
}

function markSeriesDiscoveryDeferredInStore(store, group, now, reason) {
  for (const book of store.books) {
    if (!bookBelongsToSeriesDiscoveryGroup(book, group)) continue;
    book.seriesLastDiscoveredAt = now;
    book.seriesDiscoveryStatus = 'deferred';
    book.seriesDiscoverySkipReason = reason || 'source_unavailable';
    book.seriesDiscoverySkippedAt = '';
    book.seriesDiscoveryError = '';
    book.updatedAt = now;
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
    batchSize: floorNumber(settings.batchSize, 1, 50),
    listPriceChallengeBatchSize: clampNumber(settings.listPriceChallengeBatchSize, 0, 50, 50),
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
  const referenceStore = options.store || await readStoreWithPriceRepairs();
  const snapshotResult = await settleSnapshot(bookRef.asin, bookRef, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    seriesCandidateCache: options.seriesCandidateCache,
    store: referenceStore
  });
  let applied = { checkedBook: null, events: [] };

  await updateStore((store) => {
    applied = applyCheckResultToStore(store, bookRef, snapshotResult, now, checkResultApplyOptions(options));
    return store;
  });

  const sent = await sendCheckNotifications(applied.checkedBook, applied.events, options);

  return checkResultPayload(applied.checkedBook, snapshotResult, applied.events, sent);
}

async function checkOneBookInStore(store, bookRef, options = {}) {
  const now = new Date().toISOString();
  const snapshotResult = await settleSnapshot(bookRef.asin, bookRef, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    seriesCandidateCache: options.seriesCandidateCache,
    store
  });
  const applied = applyCheckResultToStore(store, bookRef, snapshotResult, now, checkResultApplyOptions(options));
  const sent = await sendCheckNotifications(applied.checkedBook, applied.events, {
    ...options,
    notificationStore: store
  });
  return checkResultPayload(applied.checkedBook, snapshotResult, applied.events, sent);
}

function checkResultApplyOptions(options = {}) {
  return {
    updateCursor: options.updateCursor,
    recordNotifications: options.recordNotifications,
    deferSeriesNotifications: options.deferSeriesNotifications,
    seriesNotificationBaselines: options.seriesNotificationBaselines,
    seriesFreshAfter: options.seriesFreshAfter
  };
}

async function retryCachedSeriesCheckFailuresInStore(store, candidates = [], options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const retries = [];
  const seenBookIds = new Set();
  for (const candidate of candidates) {
    const bookId = candidate?.bookId;
    if (!bookId || seenBookIds.has(bookId)) continue;
    seenBookIds.add(bookId);

    const book = store.books.find((item) => item.id === bookId);
    if (!book) continue;

    const snapshotResult = cachedSeriesSnapshotResultForBook(book, {
      seriesCandidateCache: options.seriesCandidateCache,
      store
    });
    if (!snapshotResult?.ok) continue;

    const now = new Date().toISOString();
    const applied = applyCheckResultToStore(store, book, snapshotResult, now, {
      updateCursor: false,
      deferSeriesNotifications: options.deferSeriesNotifications,
      seriesNotificationBaselines: options.seriesNotificationBaselines,
      seriesFreshAfter: options.seriesFreshAfter
    });
    const sent = await sendCheckNotifications(applied.checkedBook, applied.events, {
      ...options,
      notificationStore: store
    });

    retries.push({
      index: candidate.index,
      result: {
        ...checkResultPayload(applied.checkedBook, snapshotResult, applied.events, sent),
        retry: 'cached_series_price',
        originalError: candidate.originalError || ''
      }
    });
  }

  return retries;
}

function shouldRetryCheckWithCachedSeriesPrice(book = {}, result = {}) {
  if (!book?.id || !shouldUseSeriesPriceSnapshot(book)) return false;
  const error = checkResultErrorMessage(result);
  return Boolean(error && isTransientSnapshotError(error));
}

function shouldRunListPriceChallenge(source, options = {}) {
  if (options.listPriceChallenge === false) return false;
  if (options.listPriceChallenge === true) return true;
  return source === 'cron';
}

async function runListPriceChallengeInStore(store, results = [], options = {}) {
  const limit = clampNumber(options.settings?.listPriceChallengeBatchSize, 0, 50, 50);
  const { books, eligible, skippedRecentNotFound } = selectListPriceChallengeCandidates(store, results, limit);
  const summary = {
    eligible,
    limit,
    attempted: 0,
    updated: 0,
    observedFallback: 0,
    peerFallback: 0,
    notFound: 0,
    rejected: 0,
    skippedRecentNotFound,
    skippedByLimit: Math.max(0, eligible - books.length),
    stoppedByRuntimeLimit: false,
    notFoundSamples: [],
    rejectionBreakdown: [],
    errors: []
  };
  if (limit <= 0 || books.length === 0) return summary;

  const pacing = options.pacing || checkPacing();
  const now = new Date().toISOString();
  let networkAttempts = 0;
  for (const book of books) {
    if (shouldStopBeforeListPriceChallenge(options.startedAt, options.maxRuntimeMs, options.saveReserveMs)) {
      summary.stoppedByRuntimeLimit = true;
      break;
    }

    const localCandidate = localListPriceChallengeCandidateForBook(book, store);
    if (localCandidate) {
      summary.attempted += 1;
      const validation = validateListPriceChallengeCandidate(book, localCandidate.listPrice, store);
      if (!validation.ok) {
        recordListPriceChallengeAttempt(book, now, 'rejected');
        summary.rejected += 1;
        incrementListPriceChallengeRejection(summary, validation.reason);
        continue;
      }

      applyListPriceChallengeResult(book, localCandidate.listPrice, localCandidate.provider, now);
      summary.updated += 1;
      if (localCandidate.provider === OBSERVED_PEER_LIST_PRICE_PROVIDER) {
        summary.peerFallback += 1;
      } else {
        summary.observedFallback += 1;
      }
      continue;
    }

    if (!(await waitBeforeCheck(pacing, networkAttempts, options.startedAt, options.maxRuntimeMs, options.saveReserveMs))) {
      summary.stoppedByRuntimeLimit = true;
      break;
    }

    const runtime = runtimeAbortOptions(options.startedAt, options.maxRuntimeMs, {
      reserveMs: options.saveReserveMs,
      capMs: listPriceChallengeSnapshotTimeoutMs()
    });
    summary.attempted += 1;
    networkAttempts += 1;
    try {
      const snapshot = await fetchAmazonHtmlSnapshot(book.asin, amazonUrlForAsin(book.asin), {
        ...book,
        signal: runtime.signal,
        timeoutMs: listPriceChallengeSnapshotTimeoutMs(),
        allowAmazonExtendedFallback: false,
        allowAmazonSearchFallback: false,
        allowAmazonReaderFallback: false,
        allowExternalPriceFallback: false,
        preferListasinFallback: false,
        minimumListPriceExclusive: book.currentPrice
      });
      const listPrice = trustedListPriceFor(book.currentPrice, snapshot.listPrice, snapshot.provider);
      if (listPrice == null) {
        recordListPriceChallengeAttempt(book, now, 'not_found');
        pushListPriceChallengeNotFoundSample(summary, book, snapshot);
        summary.notFound += 1;
        continue;
      }

      const validation = validateListPriceChallengeCandidate(book, listPrice, store);
      if (!validation.ok) {
        recordListPriceChallengeAttempt(book, now, 'rejected');
        summary.rejected += 1;
        incrementListPriceChallengeRejection(summary, validation.reason);
        continue;
      }

      applyListPriceChallengeResult(book, listPrice, snapshot.provider, now);
      summary.updated += 1;
    } catch (error) {
      recordListPriceChallengeAttempt(book, now, 'error');
      pushListPriceChallengeError(summary, book, error);
    } finally {
      runtime.cleanup();
    }
  }

  return summary;
}

export function selectListPriceChallengeCandidates(store = {}, results = [], limit = 50) {
  const booksById = new Map((store.books || []).map((book) => [book.id, book]));
  const seen = new Set();
  const candidates = [];
  let skippedRecentNotFound = 0;
  const nowMs = Date.now();

  for (const result of results || []) {
    const id = result?.book?.id;
    if (!result?.ok || !id || seen.has(id)) continue;
    seen.add(id);

    const book = booksById.get(id);
    if (!book) continue;
    if (!hasTrustedCurrentPrice(book)) continue;
    if (hasDirectStoredListPrice(book)) continue;
    if (isRecentListPriceChallengeNotFound(book, nowMs) && !localListPriceChallengeCandidateForBook(book, store)) {
      skippedRecentNotFound += 1;
      continue;
    }
    candidates.push(book);
  }

  const normalizedLimit = clampNumber(limit, 0, 50, 50);
  const books = spreadListPriceChallengeCandidates(candidates, normalizedLimit, store);
  return {
    eligible: candidates.length,
    skippedRecentNotFound,
    books
  };
}

function spreadListPriceChallengeCandidates(candidates = [], limit = 50, store = {}) {
  const normalizedLimit = clampNumber(limit, 0, 50, 50);
  if (normalizedLimit <= 0 || candidates.length === 0) return [];

  const buckets = new Map();
  for (const book of orderedListPriceChallengeCandidates(candidates, store)) {
    const key = listPriceChallengeScopeKey(book);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(book);
  }

  const selected = [];
  for (let round = 0; round < LIST_PRICE_CHALLENGE_MAX_PER_SERIES && selected.length < normalizedLimit; round += 1) {
    for (const bucket of buckets.values()) {
      const book = bucket[round];
      if (!book) continue;
      selected.push(book);
      if (selected.length >= normalizedLimit) break;
    }
  }
  return selected;
}

function orderedListPriceChallengeCandidates(candidates = [], store = {}) {
  return candidates
    .map((book, index) => ({
      book,
      index,
      priority: listPriceChallengeCandidatePriority(book, store)
    }))
    .sort((left, right) => {
      if (left.priority.observedDiscountScore !== right.priority.observedDiscountScore) {
        return right.priority.observedDiscountScore - left.priority.observedDiscountScore;
      }
      if (left.priority.notFoundCount !== right.priority.notFoundCount) {
        return left.priority.notFoundCount - right.priority.notFoundCount;
      }
      if (left.priority.lastAttemptedAt !== right.priority.lastAttemptedAt) {
        if (!left.priority.lastAttemptedAt) return -1;
        if (!right.priority.lastAttemptedAt) return 1;
        return left.priority.lastAttemptedAt - right.priority.lastAttemptedAt;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.book);
}

function listPriceChallengeCandidatePriority(book = {}, store = {}) {
  const current = nullableNumber(book.effectivePrice ?? book.currentPrice);
  const history = listPriceChallengeHistoryContext(book, store);
  const observedDiscountScore =
    current != null && history.maxObserved != null && history.maxObserved > 0
      ? Math.max(0, (history.maxObserved - current) / history.maxObserved)
      : 0;
  return {
    observedDiscountScore,
    notFoundCount: Math.max(0, floorNumber(book.listPriceNotFoundCount, 0, 0)),
    lastAttemptedAt: timestampMs(book.listPriceLastAttemptedAt)
  };
}

function listPriceChallengeScopeKey(book = {}) {
  if (book.seriesKey) return `seriesKey:${book.seriesKey}`;
  if (book.sourceUrl && book.importMode === 'kindle_series') return `sourceUrl:${book.sourceUrl}`;
  if (book.seriesName && book.importMode === 'kindle_series') return `seriesName:${book.seriesName}`;
  return `book:${book.id || book.asin || book.title || ''}`;
}

function hasDirectStoredListPrice(book = {}) {
  const listPrice = nullableNumber(book.listPrice);
  if (listPrice == null) return false;
  return !shouldIgnoreListPriceForProvider(book.currentPrice, listPrice, listPriceProviderForBook(book));
}

export function validateListPriceChallengeCandidate(book = {}, listPrice, store = {}) {
  const candidate = nullableNumber(listPrice);
  if (candidate == null || candidate <= 0) return { ok: false, reason: 'list_price_missing' };

  const currentPrice = nullableNumber(book.currentPrice);
  if (currentPrice == null || currentPrice < 0) return { ok: false, reason: 'current_price_missing' };
  if (candidate <= currentPrice) return { ok: false, reason: 'not_above_current_price' };

  const history = listPriceChallengeHistoryContext(book, store);
  if (history.maxObserved != null && history.hasMeaningfulCeiling) {
    if (candidate > history.maxObserved * 1.8 && candidate - history.maxObserved >= 1000) {
      return { ok: false, reason: 'above_price_history' };
    }
    if (candidate < history.maxObserved * 0.55 && history.maxObserved - candidate >= 500) {
      return { ok: false, reason: 'below_price_history' };
    }
  }

  return { ok: true, reason: '' };
}

export function observedListPriceCandidateForBook(book = {}, store = {}) {
  const currentPrice = nullableNumber(book.currentPrice);
  if (currentPrice == null || currentPrice <= 0) return null;

  const history = listPriceChallengeHistoryContext(book, store);
  if (!history.hasMeaningfulCeiling || history.maxObserved == null) return null;

  const candidate = Math.round(history.maxObserved);
  if (candidate <= currentPrice) return null;
  return candidate;
}

export function observedPeerListPriceCandidateForBook(book = {}, store = {}) {
  const currentPrice = nullableNumber(book.currentPrice);
  if (currentPrice == null || currentPrice <= 0) return null;

  const scopeKey = listPriceChallengeScopeKey(book);
  if (!scopeKey || scopeKey.startsWith('book:')) return null;

  const books = Array.isArray(store.books) ? store.books : [];
  const booksById = new Map(books.map((item) => [item.id, item]));
  const candidates = new Map();
  const addCandidate = (value, peerId) => {
    const number = nullableNumber(value);
    if (number == null || number <= 0) return;
    const candidate = Math.round(number);
    if (!isMeaningfulListPriceAboveCurrent(candidate, currentPrice)) return;
    if (!candidates.has(candidate)) {
      candidates.set(candidate, { candidate, peerIds: new Set() });
    }
    candidates.get(candidate).peerIds.add(peerId);
  };

  for (const peer of books) {
    if (!peer || peer.id === book.id) continue;
    if (listPriceChallengeScopeKey(peer) !== scopeKey) continue;
    const peerId = peer.id || peer.asin || peer.title || '';
    if (!peerId) continue;

    if (hasDirectStoredListPrice(peer)) {
      addCandidate(peer.listPrice, peerId);
    }
    if (hasTrustedCurrentPrice(peer)) {
      addCandidate(peer.currentPrice, peerId);
    }
  }

  for (const entry of store.priceHistory || []) {
    const peer = entry?.bookId ? booksById.get(entry.bookId) : books.find((item) => isPriceHistoryEntryForBook(entry, item));
    if (!peer || peer.id === book.id || listPriceChallengeScopeKey(peer) !== scopeKey) continue;
    if (isUnvalidatedSeriesPriceHistoryEntry(entry)) continue;
    if (isSuspiciousHistoryEntry(entry, peer)) continue;
    addCandidate(entry.price, peer.id || peer.asin || peer.title || '');
  }

  const ranked = [...candidates.values()]
    .map((entry) => ({ candidate: entry.candidate, count: entry.peerIds.size }))
    .filter((entry) => entry.count >= 2)
    .sort((left, right) => {
      if (left.count !== right.count) return right.count - left.count;
      return left.candidate - right.candidate;
    });

  return ranked[0]?.candidate ?? null;
}

function localListPriceChallengeCandidateForBook(book = {}, store = {}) {
  const observed = observedListPriceCandidateForBook(book, store);
  if (observed != null) {
    return { listPrice: observed, provider: OBSERVED_LIST_PRICE_PROVIDER };
  }

  const peer = observedPeerListPriceCandidateForBook(book, store);
  if (peer != null) {
    return { listPrice: peer, provider: OBSERVED_PEER_LIST_PRICE_PROVIDER };
  }

  return null;
}

function isMeaningfulListPriceAboveCurrent(listPrice, currentPrice) {
  const candidate = nullableNumber(listPrice);
  const current = nullableNumber(currentPrice);
  return candidate != null && current != null && candidate >= current * 1.25 && candidate - current >= 100;
}

function listPriceChallengeHistoryContext(book = {}, store = {}) {
  const values = [];
  const push = (value) => {
    const number = nullableNumber(value);
    if (number != null && number > 0) values.push(number);
  };

  push(book.currentPrice);
  push(book.effectivePrice);
  for (const entry of store.priceHistory || []) {
    if (!isPriceHistoryEntryForBook(entry, book)) continue;
    if (isUnvalidatedSeriesPriceHistoryEntry(entry)) continue;
    if (isSuspiciousHistoryEntry(entry, book)) continue;
    push(entry.price);
    push(entry.effectivePrice);
  }

  if (values.length === 0) {
    return { maxObserved: null, hasMeaningfulCeiling: false };
  }

  const maxObserved = Math.max(...values);
  const currentPrice = nullableNumber(book.currentPrice);
  const hasMeaningfulCeiling =
    currentPrice != null &&
    maxObserved >= currentPrice * 1.25 &&
    maxObserved - currentPrice >= 100;
  return { maxObserved, hasMeaningfulCeiling };
}

function applyListPriceChallengeResult(book, listPrice, provider, now) {
  book.listPrice = listPrice;
  book.listPriceProvider = provider || 'amazon_html';
  recordListPriceChallengeAttempt(book, now, 'updated');
  book.updatedAt = now;
}

function recordListPriceChallengeAttempt(book, now, status) {
  book.listPriceLastAttemptedAt = now;
  book.listPriceLastAttemptStatus = status;
  if (status === 'not_found') {
    book.listPriceLastNotFoundAt = now;
    book.listPriceNotFoundCount = Math.max(0, floorNumber(book.listPriceNotFoundCount, 0, 0)) + 1;
    return;
  }
  if (status === 'updated') {
    book.listPriceLastNotFoundAt = '';
    book.listPriceNotFoundCount = 0;
  }
}

function isRecentListPriceChallengeNotFound(book = {}, nowMs = Date.now()) {
  const retryMs = listPriceChallengeNotFoundRetryMs();
  if (retryMs <= 0) return false;
  const lastNotFoundAt = timestampMs(book.listPriceLastNotFoundAt);
  if (!lastNotFoundAt) return false;
  return nowMs - lastNotFoundAt < retryMs;
}

function listPriceChallengeNotFoundRetryMs() {
  const hours = floorNumber(process.env.LIST_PRICE_NOT_FOUND_RETRY_HOURS, 0, 168);
  return hours * 60 * 60 * 1000;
}

function incrementListPriceChallengeRejection(summary, reason) {
  const normalized = reason || 'rejected';
  const existing = summary.rejectionBreakdown.find((entry) => entry.reason === normalized);
  if (existing) {
    existing.count += 1;
  } else {
    summary.rejectionBreakdown.push({ reason: normalized, count: 1 });
  }
}

function pushListPriceChallengeNotFoundSample(summary, book, snapshot = {}) {
  if (summary.notFoundSamples.length >= LIST_PRICE_CHALLENGE_SAMPLE_LIMIT) return;
  summary.notFoundSamples.push({
    asin: book.asin || '',
    title: truncateSummaryText(book.title || '', 80),
    currentPrice: nullableNumber(book.currentPrice),
    effectivePrice: nullableNumber(book.effectivePrice ?? book.currentPrice),
    provider: snapshot?.provider || '',
    rawListPrice: nullableNumber(snapshot?.listPrice),
    reason: listPriceChallengeNotFoundReason(book, snapshot)
  });
}

function listPriceChallengeNotFoundReason(book = {}, snapshot = {}) {
  const rawListPrice = nullableNumber(snapshot?.listPrice);
  if (rawListPrice == null) return 'list_price_missing';
  if (isSeriesDerivedPriceProvider(snapshot?.provider || '')) return 'series_derived_provider';
  const currentPrice = nullableNumber(book.currentPrice);
  if (currentPrice != null && rawListPrice <= currentPrice) return 'not_above_current_price';
  return 'untrusted_list_price';
}

function pushListPriceChallengeError(summary, book, error) {
  if (summary.errors.length >= 10) return;
  summary.errors.push({
    asin: book.asin || '',
    title: truncateSummaryText(book.title || '', 80),
    error: truncateSummaryText(error?.message || String(error), 120)
  });
}

function listPriceChallengeSnapshotTimeoutMs() {
  return floorNumber(process.env.LIST_PRICE_CHALLENGE_SNAPSHOT_TIMEOUT_MS, 1000, 20000);
}

function shouldStopBeforeListPriceChallenge(startedAt, maxRuntimeMs, reserveMs = 0) {
  if (shouldStopForRuntimeLimit(startedAt, maxRuntimeMs, 0, reserveMs)) return true;
  return maxRuntimeMs > 0 && remainingRuntimeMs(startedAt, maxRuntimeMs, reserveMs) <= minimumUsefulListPriceChallengeRuntimeMs();
}

function minimumUsefulListPriceChallengeRuntimeMs() {
  const configured = floorNumber(process.env.LIST_PRICE_CHALLENGE_MIN_RUNTIME_MS, 0, 0);
  if (configured > 0) return configured;
  return Math.max(30000, listPriceChallengeSnapshotTimeoutMs() + 10000);
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
      restoreMissingCurrent: true,
      clearStaleDiscountedCurrent: isSuspiciousSnapshotError(snapshotResult.error)
    });
    if (isPermanentSnapshotError(snapshotResult.error) || isTrustedSeriesOverrideSnapshotError(snapshotResult.error)) {
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
  applyMergedSnapshotListPrice(book, snapshot);
  applySnapshotPriceEvidence(book, snapshot);
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
    if (!isActiveSeriesAggregateSnapshot(context.seriesBaseline) || !isActiveSeriesAggregateSnapshot(after)) {
      return [];
    }
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
    if (!isActiveSeriesAggregateSnapshot(baseline)) return null;
    baseline.freshAfter = options.seriesFreshAfter || '';
    options.seriesNotificationBaselines.set(seriesScope.key, baseline);
    return baseline;
  }

  const baseline = seriesAggregateSnapshot(store, seriesScope);
  return isActiveSeriesAggregateSnapshot(baseline) ? baseline : null;
}

async function sendDeferredSeriesNotifications(store, baselines, options = {}) {
  const sent = [];
  if (options.recordNotifications === false) return sent;
  if (!baselines || baselines.size === 0) return sent;

  const settings = mergedRuntimeSettings(store.settings);
  const now = new Date().toISOString();
  for (const baseline of baselines.values()) {
    if (!isActiveSeriesAggregateSnapshot(baseline)) continue;
    let after = seriesAggregateSnapshot(store, baseline.scope, { freshAfter: baseline.freshAfter });
    if (!isActiveSeriesAggregateSnapshot(after)) continue;
    appendSeriesPriceHistoryEntry(store, after, now);
    after = seriesAggregateSnapshot(store, baseline.scope, { freshAfter: baseline.freshAfter });
    if (!isActiveSeriesAggregateSnapshot(after)) continue;
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
  if (context.source !== 'cron') return null;
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
    resultErrors:
      result.checkErrorSummary?.total ??
      (result.results || []).filter((entry) => entry?.ok === false || entry?.error).length,
    checkErrorBreakdown: result.checkErrorSummary?.breakdown || [],
    checkErrorSamples: result.checkErrorSummary?.samples || [],
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
          deferred: result.seriesDiscovery.deferred || 0,
          markedNoRun: result.seriesDiscovery.markedNoRun || 0,
          errors: result.seriesDiscovery.errors?.length || 0
        }
      : null,
    listPriceChallenge: result.listPriceChallenge
      ? {
          eligible: result.listPriceChallenge.eligible || 0,
          limit: result.listPriceChallenge.limit || 0,
          attempted: result.listPriceChallenge.attempted || 0,
          updated: result.listPriceChallenge.updated || 0,
          observedFallback: result.listPriceChallenge.observedFallback || 0,
          peerFallback: result.listPriceChallenge.peerFallback || 0,
          notFound: result.listPriceChallenge.notFound || 0,
          rejected: result.listPriceChallenge.rejected || 0,
          skippedRecentNotFound: result.listPriceChallenge.skippedRecentNotFound || 0,
          skippedByLimit: result.listPriceChallenge.skippedByLimit || 0,
          stoppedByRuntimeLimit: Boolean(result.listPriceChallenge.stoppedByRuntimeLimit),
          errors: result.listPriceChallenge.errors?.length || 0,
          notFoundSamples: result.listPriceChallenge.notFoundSamples || [],
          rejectionBreakdown: result.listPriceChallenge.rejectionBreakdown || []
        }
      : null,
    priceIntegrityAudit: result.priceIntegrityAudit
      ? {
          checked: result.priceIntegrityAudit.checked || 0,
          suspicious: result.priceIntegrityAudit.suspicious || 0,
          warnings: result.priceIntegrityAudit.warnings || 0,
          rechecked: result.priceIntegrityAudit.rechecked || 0,
          repaired: result.priceIntegrityAudit.repaired || 0,
          unresolved: result.priceIntegrityAudit.unresolved || 0,
          skipped: result.priceIntegrityAudit.skipped || 0,
          findings: result.priceIntegrityAudit.findings || []
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
    const seriesSnapshot = await fetchSeriesPriceSnapshotForBook(asin, book, options);
    const snapshot =
      seriesSnapshot ||
      await fetchBookSnapshot(asin, {
        ...book,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        url: options.url || snapshotInputUrlForBook(book),
        allowAmazonExtendedFallback: shouldAllowAmazonExtendedFallbackForBook(book, options),
        allowAmazonSearchFallback: shouldAllowAmazonSearchFallbackForBook(book, options),
        preferListasinFallback: shouldPreferListasinFallbackForBook(book, options)
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

export function snapshotInputUrlForBook(book = {}) {
  const normalizedAsin = String(book.asin || '').toUpperCase();
  const candidates = [book.amazonUrl, book.sourceUrl]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return candidates.find((url) => extractAsin(url) === normalizedAsin) || '';
}

function canonicalSingleBookSourceUrl(asin, input = '') {
  const normalizedAsin = String(asin || extractAsin(input) || '').toUpperCase();
  if (!normalizedAsin) return String(input || '').trim();
  return amazonUrlForAsin(normalizedAsin);
}

async function fetchSeriesPriceSnapshotForBook(asin, book = {}, options = {}) {
  if (!shouldUseSeriesPriceSnapshot(book, options)) return null;

  const input = seriesDiscoveryInput(book.sourceUrl, book.seriesKey);
  if (!input) return null;

  try {
    const series = await fetchSeriesCandidates(input, {
      ...options,
      allowIncomplete: true,
      skipBackfill: true,
      skipExternalFallback: options.skipExternalFallback ?? true
    });
    return seriesSnapshotFromKindleSeriesForBook(series, asin, book, {
      store: options.store
    });
  } catch {
    return null;
  }
}

export function canUseCachedSeriesPriceSnapshotForBook(book = {}, options = {}) {
  return Boolean(cachedSeriesSnapshotResultForBook(book, options)?.ok);
}

function cachedSeriesSnapshotResultForBook(book = {}, options = {}) {
  if (!shouldUseSeriesPriceSnapshot(book, options)) return null;

  const input = seriesDiscoveryInput(book.sourceUrl, book.seriesKey);
  if (!input) return null;

  const series = cachedKindleSeriesCandidate(input, options);
  if (!series) return null;

  const snapshot = seriesSnapshotFromKindleSeriesForBook(series, book.asin, book, {
    store: options.store
  });
  if (!snapshot || snapshot.currentPrice == null) return null;

  const suspiciousReason = suspiciousSnapshotReason(book, snapshot);
  if (suspiciousReason) {
    return {
      ok: false,
      snapshot,
      error: `疑わしい価格を無視しました (${suspiciousReason})`
    };
  }

  return { ok: true, snapshot };
}

function shouldUseSeriesPriceSnapshot(book = {}, options = {}) {
  if (options.seriesPriceFirst === false) return false;
  if (String(process.env.SERIES_PRICE_CHECK_FIRST || 'true').toLowerCase() === 'false') return false;
  if (book.importMode !== 'kindle_series' && !book.seriesKey) return false;
  return Boolean(book.sourceUrl || book.seriesKey);
}

function shouldAllowAmazonExtendedFallbackForBook(book = {}, options = {}) {
  if (typeof options.allowAmazonExtendedFallback === 'boolean') return options.allowAmazonExtendedFallback;
  if (readEnvBoolean('AMAZON_EXTENDED_FALLBACK_EXISTING', false)) return true;
  return !hasReusableStoredPriceAndDirectUrl(book);
}

function shouldAllowAmazonSearchFallbackForBook(book = {}, options = {}) {
  if (typeof options.allowAmazonSearchFallback === 'boolean') return options.allowAmazonSearchFallback;
  if (readEnvBoolean('AMAZON_SEARCH_FALLBACK_EXISTING', false)) return true;
  return !hasReusableStoredPriceAndDirectUrl(book);
}

function shouldPreferListasinFallbackForBook(_book = {}, options = {}) {
  if (typeof options.preferListasinFallback === 'boolean') return options.preferListasinFallback;
  return true;
}

function hasReusableStoredPriceAndDirectUrl(book = {}) {
  const price = nullableNumber(book.currentPrice ?? book.effectivePrice);
  return price != null && price > 0 && Boolean(snapshotInputUrlForBook(book));
}

export function seriesSnapshotFromKindleSeriesForBook(series, asin, book = {}, options = {}) {
  const normalizedAsin = String(asin || '').toUpperCase();
  const item = (series?.items || []).find((candidate) => candidate?.asin === normalizedAsin);
  if (!item || item.currentPrice == null) return null;
  const validatedByTrustedSiblings =
    isUnvalidatedSeriesPriceProvider(item.provider) &&
    isSeriesItemValidatedByTrustedSiblings(series, item, book, options.store);
  if (isUnvalidatedSeriesPriceProvider(item.provider) && !validatedByTrustedSiblings) {
    return null;
  }
  if (isUnverifiedFreeSeriesPriceProvider(item.provider, item.currentPrice)) return null;

  const provider = validatedByTrustedSiblings
    ? 'validated_series_fallback'
    : item.provider || series?.provider || 'amazon_series_child';
  const currentPrice = Number(item.currentPrice);
  const currentPoints = Number(item.currentPoints || 0);
  const effectivePrice = item.effectivePrice ?? effectivePriceFromSeed(item);
  return {
    asin: normalizedAsin,
    title: item.title || book.title || `ASIN ${normalizedAsin}`,
    author: item.author || book.author || '',
    publisher: item.publisher || book.publisher || '',
    imageUrl: item.imageUrl || book.imageUrl || '',
    amazonUrl: item.amazonUrl || book.amazonUrl || amazonUrlForAsin(normalizedAsin),
    currentPrice,
    currentPoints,
    effectivePrice,
    listPrice: trustedListPriceFor(currentPrice, item.listPrice, provider),
    provider
  };
}

function isSeriesItemValidatedByTrustedSiblings(series, item, book = {}, store = {}) {
  if (!store || !Array.isArray(store.books)) return false;

  const candidatesByAsin = new Map((series?.items || []).map((candidate) => [candidate?.asin, candidate]));
  const requiredMatches = floorNumber(process.env.SERIES_UNVALIDATED_PRICE_MIN_MATCHES, 1, 2);
  let matches = 0;

  for (const sibling of store.books) {
    if (!isSameSeriesBookForPriceValidation(sibling, book)) continue;
    if (String(sibling.asin || '').toUpperCase() === String(item.asin || '').toUpperCase()) continue;
    if (!hasTrustedCurrentPrice(sibling)) continue;

    const candidate = candidatesByAsin.get(String(sibling.asin || '').toUpperCase());
    if (!candidate || candidate.currentPrice == null) continue;
    if (!seriesCandidatePriceMatchesBook(candidate, sibling)) return false;

    matches += 1;
    if (matches >= requiredMatches) return true;
  }

  return false;
}

function isSameSeriesBookForPriceValidation(candidate = {}, book = {}) {
  if (book.seriesKey && candidate.seriesKey === book.seriesKey) return true;
  if (book.sourceUrl && candidate.sourceUrl && isSameSeriesSource(candidate.sourceUrl, book.sourceUrl, extractAsin(book.sourceUrl))) {
    return true;
  }
  return Boolean(book.seriesName && candidate.seriesName === book.seriesName);
}

function seriesCandidatePriceMatchesBook(candidate = {}, book = {}) {
  const candidatePrice = nullableNumber(candidate.currentPrice);
  const bookPrice = nullableNumber(book.currentPrice);
  if (candidatePrice == null || bookPrice == null || candidatePrice !== bookPrice) return false;

  const candidateEffective = nullableNumber(candidate.effectivePrice ?? effectivePriceFromSeed(candidate));
  const bookEffective = nullableNumber(book.effectivePrice ?? effectivePriceFromSeed(book));
  if (candidateEffective != null && bookEffective != null && candidateEffective !== bookEffective) return false;

  return true;
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

function applySnapshotPriceEvidence(book, snapshot) {
  if (!book || !snapshot) return;
  book.explicitPriceDisplay = Boolean(snapshot.explicitPriceDisplay);
  book.explicitFreeKindlePrice = Boolean(snapshot.explicitFreeKindlePrice);
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
    provider: fallbackProvider,
    explicitPriceDisplay: Boolean(seed.explicitPriceDisplay),
    explicitFreeKindlePrice: Boolean(seed.explicitFreeKindlePrice)
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
    explicitPriceDisplay: Boolean(snapshot.explicitPriceDisplay),
    explicitFreeKindlePrice: Boolean(snapshot.explicitFreeKindlePrice),
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
    provider: snapshot.provider || fallback.provider,
    explicitPriceDisplay: Boolean(snapshot.explicitPriceDisplay ?? fallback.explicitPriceDisplay),
    explicitFreeKindlePrice: Boolean(snapshot.explicitFreeKindlePrice ?? fallback.explicitFreeKindlePrice)
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

export function canonicalSeriesSourceAsin(input, series = {}) {
  const inputAsin = extractAsin(input);
  const seriesAsin = String(series.sourceAsin || '').toUpperCase();
  if (
    inputAsin &&
    seriesAsin &&
    seriesAsin !== inputAsin &&
    Array.isArray(series.items) &&
    series.items.some((item) => String(item?.asin || '').toUpperCase() === inputAsin)
  ) {
    return seriesAsin;
  }
  if (inputAsin && isKindleSeriesUrl(input)) return inputAsin;
  return seriesAsin || inputAsin || '';
}

export function seriesKeyForSeries(input, series = {}) {
  const asin = canonicalSeriesSourceAsin(input, series);
  if (asin) return `series:asin:${asin}`;
  return `series:${crypto.createHash('sha1').update(String(input || '').trim()).digest('hex').slice(0, 16)}`;
}

export function seriesSourceUrlFor(input, series = {}) {
  const asin = canonicalSeriesSourceAsin(input, series);
  return asin ? kindleSeriesUrlForAsin(asin) : String(input || '').trim();
}

function kindleSeriesUrlForAsin(asin) {
  const host = process.env.AMAZON_HOST || 'www.amazon.co.jp';
  return `https://${host}/kindle-dbs/product/${asin}`;
}

function kindleSeriesFetchUrlForAsin(asin) {
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
    listPriceProvider: book.listPrice == null ? '' : listPriceProviderForBook(book),
    provider: book.provider,
    explicitPriceDisplay: Boolean(book.explicitPriceDisplay),
    explicitFreeKindlePrice: Boolean(book.explicitFreeKindlePrice),
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
    nullableNumber(left.listPrice) === nullableNumber(right.listPrice) &&
    Boolean(left.explicitPriceDisplay) === Boolean(right.explicitPriceDisplay) &&
    Boolean(left.explicitFreeKindlePrice) === Boolean(right.explicitFreeKindlePrice)
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

function publicBookWithSeriesHistory(book, seriesHistory, discountReferences = new Map()) {
  const result = publicBookWithObservedDiscountReference(book, discountReferences);
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

function publicBookWithObservedDiscountReference(book, discountReferences = new Map()) {
  const result = publicBook(book);
  if (result.listPrice != null) return result;

  const reference = observedDiscountReferenceForBook(book, discountReferences);
  if (!reference || reference.price == null) return result;

  return {
    ...result,
    discountReferencePrice: reference.price,
    discountReferenceSource: reference.source,
    discountRate: discountRateForReference(result.effectivePrice, reference.price)
  };
}

function observedDiscountReferenceForBook(book, references) {
  if (!book || !references) return null;
  return references.get(book.id) || references.get(`asin:${book.asin}`) || null;
}

function observedDiscountReferenceSummaries(store) {
  const references = new Map();
  const booksById = new Map((store.books || []).map((book) => [book.id, book]));
  const booksByAsin = new Map((store.books || []).map((book) => [String(book.asin || ''), book]).filter(([asin]) => asin));

  const add = (book, price, source) => {
    const referencePrice = nullableNumber(price);
    if (!book?.id || referencePrice == null || referencePrice <= 0) return;
    setObservedDiscountReference(references, book.id, referencePrice, source);
    if (book.asin) setObservedDiscountReference(references, `asin:${book.asin}`, referencePrice, source);
  };

  for (const book of store.books || []) {
    if (isUnvalidatedSeriesPriceProvider(book.provider) || isUnverifiedFreeSeriesPriceProvider(book.provider, book.currentPrice)) {
      continue;
    }
    add(book, book.currentPrice, 'current_observed');
  }

  for (const entry of store.priceHistory || []) {
    const book = (entry.bookId && booksById.get(entry.bookId)) || (entry.asin && booksByAsin.get(String(entry.asin))) || null;
    if (!book) continue;
    if (isUnvalidatedSeriesPriceHistoryEntry(entry) || isSuspiciousHistoryEntry(entry, book)) continue;
    add(book, entry.price, 'history_observed');
  }

  return references;
}

function setObservedDiscountReference(references, key, price, source) {
  const current = references.get(key);
  if (current && current.price >= price) return;
  references.set(key, { price, source });
}

function discountRateForReference(effectivePrice, referencePrice) {
  const current = nullableNumber(effectivePrice);
  const reference = nullableNumber(referencePrice);
  if (current == null || reference == null || reference <= 0) return null;
  return Math.max(0, Math.round(((reference - current) / reference) * 100));
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

export function seriesAggregateSnapshot(store, scope, options = {}) {
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
  const hasCompleteCheckedTimes = checkedTimes.length > 0 && checkedTimes.length === books.length;
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
    currentPointsTotal:
      books.length > 0 && currentPrices.every((value) => value != null) ? sumNumbers(currentPoints) : null,
    currentEffectiveTotal: sumWhenComplete(currentEffectivePrices),
    observedFrom: hasCompleteCheckedTimes ? new Date(checkedTimes[0]).toISOString() : '',
    observedTo: hasCompleteCheckedTimes ? new Date(checkedTimes[checkedTimes.length - 1]).toISOString() : ''
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

export function isActiveSeriesAggregateSnapshot(snapshot) {
  return Boolean(snapshot && snapshot.bookCount > 0 && snapshot.representativeBook);
}

function seriesAggregateFreshAfter(now = Date.now()) {
  const timestamp = Number(now);
  const base = Number.isFinite(timestamp) ? timestamp : Date.now();
  return new Date(recentJstExecutionBoundaryMs(base, seriesAggregateObservationRuns()));
}

function recentJstExecutionBoundaryMs(now, runCount = 5) {
  const count = floorNumber(runCount, 1, 5);
  const dayMs = 24 * 60 * 60 * 1000;
  const times = scheduledExecutionTimes().sort(
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

  return boundaries[count - 1] ?? latestJstExecutionBoundaryMs(now);
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

  const dueBefore = Number.isFinite(options.dueCutoffMs)
    ? options.dueCutoffMs
    : scheduledDueCutoffMs(now);
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
  const seriesFreshAfterMs = seriesAggregateFreshAfter(now).getTime();

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
  if (needsDiscountExpiryRecheck(book, now)) score += 45000;
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

export function needsDiscountExpiryRecheck(book, now = Date.now()) {
  if (!hasTrustedCurrentPrice(book)) return false;

  const checkedAt = new Date(book?.lastCheckedAt || 0).getTime();
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return true;

  const ageMs = now - checkedAt;
  const thresholdHours = floorNumber(process.env.DISCOUNT_RECHECK_HOURS, 1, DISCOUNT_RECHECK_DEFAULT_HOURS);
  if (ageMs < thresholdHours * 60 * 60 * 1000) return false;

  const effective = nullableNumber(book.effectivePrice ?? book.currentPrice);
  const listPrice = nullableNumber(trustedListPriceFor(book.currentPrice, book.listPrice, book.provider));
  if (effective == null || effective <= 0 || listPrice == null || listPrice <= 0) return false;

  return effective <= listPrice * DISCOUNT_RECHECK_RATIO;
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

function countDueBooks(books, now) {
  const dueBefore = scheduledDueCutoffMs(now);
  return books.filter((book) => isBookDue(book, dueBefore)).length;
}

function isBookDue(book, dueBefore) {
  if (!book.lastCheckedAt) return true;
  const checkedAt = new Date(book.lastCheckedAt).getTime();
  return !Number.isFinite(checkedAt) || checkedAt <= dueBefore;
}

function scheduledDueCutoffMs(now) {
  return latestJstExecutionBoundaryMs(now);
}

function shouldWaitForScheduledExecutionWindow(source, options = {}, now = Date.now()) {
  if (options.ignoreExecutionWindow === true) return false;
  if (source !== 'cron') return false;
  if (options.scheduleIntent) return false;
  const firstBoundary = todayJstExecutionBoundaryMs(now, scheduledExecutionTimes()[0]);
  if (now < firstBoundary) return true;

  const latestBoundary = latestJstExecutionBoundaryMs(now);
  return now - latestBoundary > scheduledExecutionGraceMs();
}

const DAILY_CRON_EXECUTION_WINDOWS = new Map([
  ['54 18 * * *', { targetIndex: 0, backup: false }],
  ['54 6 * * *', { targetIndex: 1, backup: false }]
]);

export function resolveCronScheduleIntent(scheduleCron, now = Date.now()) {
  const normalized = normalizeScheduleCron(scheduleCron);
  if (!normalized) return null;

  const definition = DAILY_CRON_EXECUTION_WINDOWS.get(normalized);
  if (!definition) return null;

  const parsed = parseDailyUtcCron(normalized);
  if (!parsed) return null;

  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) return null;

  const times = scheduledExecutionTimes();
  const target = times[definition.targetIndex];
  if (!target) return null;

  const nominalMs = latestDailyUtcCronOccurrenceMs(nowMs, parsed.hour, parsed.minute);
  const nominalJstDayStartMs = jstDayStartUtcMs(nominalMs);
  const executionBoundaryMs = nominalJstDayStartMs + target.hour * 60 * 60 * 1000 + target.minute * 60 * 1000;
  const nextExecutionBoundaryMs = nextJstExecutionBoundaryAfterMs(executionBoundaryMs);

  return {
    scheduleCron: normalized,
    backup: definition.backup,
    nominalAt: new Date(nominalMs).toISOString(),
    executionBoundaryMs,
    executionBoundaryAt: new Date(executionBoundaryMs).toISOString(),
    nextExecutionBoundaryMs,
    nextExecutionBoundaryAt: new Date(nextExecutionBoundaryMs).toISOString(),
    stale: nowMs >= nextExecutionBoundaryMs
  };
}

function latestJstExecutionBoundaryMs(now) {
  const todayBoundaries = scheduledExecutionTimes().map((time) => todayJstExecutionBoundaryMs(now, time));
  const latestToday = [...todayBoundaries].reverse().find((boundary) => now >= boundary);
  if (latestToday != null) return latestToday;
  return todayBoundaries[todayBoundaries.length - 1] - 24 * 60 * 60 * 1000;
}

function nextJstExecutionBoundaryMs(now) {
  const todayBoundaries = scheduledExecutionTimes().map((time) => todayJstExecutionBoundaryMs(now, time));
  return todayBoundaries.find((boundary) => now < boundary) || todayBoundaries[0] + 24 * 60 * 60 * 1000;
}

function todayJstExecutionBoundaryMs(now, time) {
  const jstDayStartUtc = jstDayStartUtcMs(Number(now));
  return jstDayStartUtc + time.hour * 60 * 60 * 1000 + time.minute * 60 * 1000;
}

function scheduledExecutionTimes() {
  return [
    { hour: 3, minute: 54 },
    { hour: 15, minute: 54 }
  ];
}

function scheduledExecutionGraceMs() {
  return floorNumber(process.env.CHECK_EXECUTION_GRACE_MINUTES, 1, 180) * 60 * 1000;
}

function backupCronSkipState(automation = {}, now = Date.now(), executionBoundaryMs = null) {
  const boundaryMs = Number.isFinite(executionBoundaryMs)
    ? executionBoundaryMs
    : latestJstExecutionBoundaryMs(now);
  return cronWindowCompletionState(automation, boundaryMs);
}

export function cronWindowCompletionState(automation = {}, executionBoundaryMs) {
  const boundaryMs = Number(executionBoundaryMs);
  if (!Number.isFinite(boundaryMs)) {
    return {
      shouldSkip: false,
      skipDetail: '',
      executionBoundaryAt: '',
      lastCronExecutionBoundaryAt: automation?.lastCronExecutionBoundaryAt || '',
      lastCronStartedAt: automation?.lastCronStartedAt || '',
      lastCronFinishedAt: automation?.lastCronFinishedAt || '',
      lastCronStoppedByRuntimeLimit: Boolean(automation?.lastCronStoppedByRuntimeLimit),
      lastCronError: String(automation?.lastCronError || '').trim()
    };
  }

  const lastFinishedMs = timestampMs(automation?.lastCronFinishedAt);
  const lastBoundaryMs = timestampMs(automation?.lastCronExecutionBoundaryAt);
  const lastCronError = String(automation?.lastCronError || '').trim();
  const lastCronStoppedByRuntimeLimit = Boolean(automation?.lastCronStoppedByRuntimeLimit);
  const nextBoundaryMs = nextJstExecutionBoundaryAfterMs(boundaryMs);
  const hasExplicitSameWindow = lastBoundaryMs === boundaryMs;
  const hasLegacySameWindow =
    !lastBoundaryMs && lastFinishedMs >= boundaryMs && lastFinishedMs < nextBoundaryMs;
  const hasSameWindowCompletion = (hasExplicitSameWindow || hasLegacySameWindow) && lastFinishedMs >= boundaryMs;
  const hasSuccessfulCompletion = hasSameWindowCompletion && !lastCronError;
  const hasSavedRuntimeLimitCompletion =
    hasSameWindowCompletion && lastCronStoppedByRuntimeLimit && !lastCronError;
  const shouldSkip = hasSuccessfulCompletion || hasSavedRuntimeLimitCompletion;

  return {
    shouldSkip,
    skipDetail: hasSavedRuntimeLimitCompletion ? 'saved_runtime_limit' : hasSuccessfulCompletion ? 'successful_completion' : '',
    executionBoundaryAt: new Date(boundaryMs).toISOString(),
    lastCronExecutionBoundaryAt: automation?.lastCronExecutionBoundaryAt || '',
    lastCronStartedAt: automation?.lastCronStartedAt || '',
    lastCronFinishedAt: automation?.lastCronFinishedAt || '',
    lastCronStoppedByRuntimeLimit,
    lastCronError
  };
}

function normalizeScheduleCron(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseDailyUtcCron(scheduleCron) {
  const parts = normalizeScheduleCron(scheduleCron).split(' ');
  if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*' || parts[4] !== '*') return null;

  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;

  return { hour, minute };
}

function latestDailyUtcCronOccurrenceMs(now, hour, minute) {
  const dayMs = 24 * 60 * 60 * 1000;
  const nowMs = Number(now);
  const utcDayStartMs = Math.floor(nowMs / dayMs) * dayMs;
  const todayMs = utcDayStartMs + hour * 60 * 60 * 1000 + minute * 60 * 1000;
  return todayMs <= nowMs ? todayMs : todayMs - dayMs;
}

function nextJstExecutionBoundaryAfterMs(boundaryMs) {
  const dayMs = 24 * 60 * 60 * 1000;
  const sameDayBoundaries = scheduledExecutionTimes()
    .map((time) => todayJstExecutionBoundaryMs(boundaryMs, time))
    .sort((left, right) => left - right);
  return sameDayBoundaries.find((candidate) => candidate > boundaryMs) || sameDayBoundaries[0] + dayMs;
}

function jstDayStartUtcMs(timestamp) {
  const dayMs = 24 * 60 * 60 * 1000;
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  return Math.floor((Number(timestamp) + jstOffsetMs) / dayMs) * dayMs - jstOffsetMs;
}

function timestampMs(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function shouldStopForRuntimeLimit(startedAt, maxRuntimeMs, _completedCount = 0, reserveMs = 0) {
  return maxRuntimeMs > 0 && remainingRuntimeMs(startedAt, maxRuntimeMs, reserveMs) <= 0;
}

function shouldStopBeforeNextBookCheck(startedAt, maxRuntimeMs, reserveMs = 0) {
  if (shouldStopForRuntimeLimit(startedAt, maxRuntimeMs, 0, reserveMs)) return true;
  return maxRuntimeMs > 0 && remainingRuntimeMs(startedAt, maxRuntimeMs, reserveMs) <= minimumUsefulBookCheckRuntimeMs();
}

function shouldStopBeforeSeriesDiscovery(startedAt, maxRuntimeMs, reserveMs = 0) {
  if (shouldStopForRuntimeLimit(startedAt, maxRuntimeMs, 0, reserveMs)) return true;
  return maxRuntimeMs > 0 && remainingRuntimeMs(startedAt, maxRuntimeMs, reserveMs) <= minimumUsefulSeriesDiscoveryRuntimeMs();
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
    blockCooldownMs: floorNumber(process.env.CHECK_BLOCK_COOLDOWN_MS, 0, 60000),
    transientErrorCooldownMs: floorNumber(process.env.CHECK_TRANSIENT_ERROR_COOLDOWN_MS, 0, 60000),
    transientErrorCooldownThreshold: floorNumber(process.env.CHECK_TRANSIENT_ERROR_COOLDOWN_THRESHOLD, 1, 50)
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

function shouldCooldownAfterTransientErrorStreak(pacing, streak) {
  const threshold = Math.max(1, Number(pacing.transientErrorCooldownThreshold || 0));
  return pacing.transientErrorCooldownMs > 0 && streak >= threshold;
}

async function waitAfterTransientErrorChecks(pacing, startedAt, maxRuntimeMs, reserveMs = 0) {
  return sleepWithinRuntime(
    randomizedDelay(pacing.transientErrorCooldownMs, Math.floor(pacing.transientErrorCooldownMs / 3)),
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

function minimumUsefulBookCheckRuntimeMs() {
  const configured = floorNumber(process.env.CHECK_MIN_BOOK_RUNTIME_MS, 0, 0);
  if (configured > 0) return configured;
  return Math.max(90000, checkBookMaxRuntimeMs() + 30000);
}

function minimumUsefulSeriesDiscoveryRuntimeMs() {
  const configured = floorNumber(process.env.SERIES_DISCOVERY_MIN_RUNTIME_MS, 0, 0);
  if (configured > 0) return configured;
  return Math.max(90000, importItemMaxRuntimeMs());
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

function isTransientCheckResult(result) {
  const value = checkResultErrorMessage(result);
  return Boolean(value && isTransientSnapshotError(value));
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

function cloneBulkStoreSnapshot(store) {
  return JSON.parse(JSON.stringify(store || {}));
}

async function persistBulkCheckStore({ store, baseStore = null, cronFields = null }) {
  const nextAutomation = {
    ...(store.automation || {}),
    ...(cronFields || {})
  };
  store.automation = nextAutomation;

  await updateStore((currentStore) => {
    const mergedStore = baseStore ? mergeBulkCheckStoreForPersist(currentStore, store, baseStore) : store;
    return {
      ...mergedStore,
      settings: currentStore.settings,
      automation: {
        ...(currentStore.automation || {}),
        ...nextAutomation
      }
    };
  });
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

function hasListPriceChallengeWork(listPriceChallenge = null) {
  if (!listPriceChallenge) return false;
  return Boolean(
    listPriceChallenge.attempted > 0 ||
      listPriceChallenge.updated > 0 ||
      listPriceChallenge.rejected > 0 ||
      listPriceChallenge.notFound > 0 ||
      listPriceChallenge.skippedRecentNotFound > 0 ||
      listPriceChallenge.stoppedByRuntimeLimit ||
      (Array.isArray(listPriceChallenge.errors) && listPriceChallenge.errors.length > 0)
  );
}

function hasSeriesDiscoveryWork(seriesDiscovery = null) {
  if (!seriesDiscovery) return false;
  return Boolean(
    seriesDiscovery.checked > 0 ||
    seriesDiscovery.added > 0 ||
    seriesDiscovery.completed > 0 ||
    seriesDiscovery.skippedNoRun > 0 ||
    seriesDiscovery.deferred > 0 ||
    seriesDiscovery.stoppedByRuntimeLimit ||
    (Array.isArray(seriesDiscovery.errors) && seriesDiscovery.errors.length > 0)
  );
}

function mergedRuntimeSettings(settings = {}) {
  return {
    notificationThreshold: clampNumber(settings.notificationThreshold, 0, 95, 10),
    batchSize: floorNumber(settings.batchSize, 1, 50),
    listPriceChallengeBatchSize: clampNumber(settings.listPriceChallengeBatchSize, 0, 50, 50),
    notifyOnPriceDrop: settings.notifyOnPriceDrop !== false,
    notifyOnBestEver: settings.notifyOnBestEver !== false
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
