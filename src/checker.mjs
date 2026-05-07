import crypto from 'node:crypto';
import {
  amazonUrlForAsin,
  extractAsin,
  fetchAmazonHtmlSnapshot,
  fetchBookSnapshot,
  fetchExternalKindleSeriesItems,
  fetchKinpomeKindleSeriesItems,
  fetchKindleSeriesItems,
  fetchSaleBonKindleSeriesItems,
  isKindleSeriesUrl
} from './price-provider.mjs';
import { readStore, updateStore, publicBook } from './store.mjs';
import { readWebhookStore, writeWebhookStore } from './webhook-store.mjs';
import {
  buildPriceNotification,
  getDiscordWebhookUrls,
  parseDiscordWebhookUrls,
  sendDiscordNotification
} from './notifier.mjs';

export async function listBooks() {
  const store = await readStore();
  return store.books.map(publicBook).sort(sortBooks);
}

export async function addBook(input) {
  const asin = extractAsin(input);
  if (!asin) {
    const error = new Error('Amazon URL または ASIN を入力してください');
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
  const now = book.createdAt;

  await updateStore((store) => {
    store.books.push(book);
    if (book.effectivePrice != null) {
      store.priceHistory.push(historyEntry(book, now));
    }
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
  let importedBooks = [];
  let skippedDuplicates = 0;
  let updatedDuplicates = 0;
  const seriesKey = seriesKeyForSeries(input, series);
  const seriesName = series.seriesName || 'Kindle シリーズ';
  const sourceUrl = seriesSourceUrlFor(input, series);
  const seriesCompleted = Boolean(series.completed);

  await updateStore(async (store) => {
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
      store.books = store.books.filter((book) => !obsoleteIds.has(book.id));
      store.priceHistory = store.priceHistory.filter((entry) => !obsoleteIds.has(entry.bookId));
      store.notifications = store.notifications.filter((entry) => !obsoleteIds.has(entry.bookId));
      resetCursorIfDeleted(store, obsoleteIds);
    }

    const existingByAsin = new Map(store.books.map((book) => [book.asin, book]));
    const seriesIdentity = {
      input,
      sourceUrl,
      sourceAsin: series.sourceAsin,
      seriesKey,
      seriesName
    };
    const seriesItems = mergeWithKnownSeriesItems(series.items, store.books, seriesIdentity);
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
        volume: seriesItemVolume(item) || index + 1
      });
      additions.push(book);
      importedBooks.push(publicBook(book));
      existingByAsin.set(asin, book);
    }

    store.books.push(...additions);
    for (const book of additions) {
      if (book.effectivePrice != null) {
        store.priceHistory.push(historyEntry(book, now));
      }
    }

    for (const book of store.books.filter((item) => isKnownBookForSeries(item, seriesIdentity))) {
      applySeriesDiscoveryMetadata(book, {
        now,
        completed: seriesCompleted,
        error: ''
      });
    }
    return store;
  });

  return {
    mode: 'kindle_series',
    imported: importedBooks.length,
    skippedDuplicates,
    updatedDuplicates,
    seriesCompleted,
    books: importedBooks,
    errors: series.reconciliation?.errors || []
  };
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
      if (isUnresolvedSingleBook(book) && book.lastCheckedAt) {
        book.lastCheckedAt = null;
        updated = true;
      }
      const repair = repairSuspiciousPriceState(book, store, {
        clearCurrent: true,
        restoreMissingCurrent: true
      });
      if (repair.changed) updated = true;
      if ((repair.currentCleared && !repair.currentRestored) || isSuspiciousSnapshotError(snapshotResult?.error)) {
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

    if (book.effectivePrice != null) {
      store.priceHistory.push(historyEntry(book, now));
    }
    if (repairSuspiciousPriceState(book, store).changed) {
      updated = true;
    }

    publicResult = publicBook(book);
    return store;
  });

  return { updated, book: publicResult || publicBook(await findBookById(id)) };
}

async function detectCollectionSeries(input) {
  return fetchSeriesCandidates(input, {
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
      const series = await fetchExternalKindleSeriesItems(input);
      if (series?.items?.length > 1) candidates.push(series);
    } catch {
      // No usable external fallback.
    }

    const saleBonNames = new Set(seriesNamesForSaleBon(candidates));
    if (saleBonNames.size === 0) {
      for (const seriesName of await sourceSeriesNamesForSaleBon(input)) saleBonNames.add(seriesName);
    }

    for (const seriesName of saleBonNames) {
      try {
        const series = await fetchSaleBonKindleSeriesItems(seriesName, { sourceAsin: extractAsin(input) });
        if (series?.items?.length > 1) candidates.push(series);
      } catch {
        // Sale-bon is an optional fallback; ignore failures and use the other candidates.
      }
    }

    if (candidates.length > 0) {
      for (const { query, seriesName } of seriesQueriesForSupplementalSources(candidates)) {
        try {
          const series = await fetchKinpomeKindleSeriesItems(query, { sourceAsin: extractAsin(input), seriesName });
          if (series?.items?.length > 1) candidates.push(series);
        } catch {
          // Kinpome is an optional price source; ignore failures and use the other candidates.
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  const merged = candidates.reduce((result, series) => mergeSeriesCandidate(result, series));
  const resolved = await resolveSeriesCandidateDiffs(merged, candidates);
  if (!isIncompleteSeriesCandidate(resolved)) return resolved;
  return options.allowIncomplete && resolved.items.length > 1 ? resolved : null;
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

async function sourceSeriesNamesForSaleBon(input) {
  const asin = extractAsin(input);
  if (!asin) return [];
  const names = new Set(seriesNameCandidatesFromAmazonSlug(input));

  try {
    const snapshot = await fetchBookSnapshot(asin, { url: input });
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
    listPrice: priceSeed?.listPrice ?? overlay.listPrice ?? base.listPrice,
    provider: priceSeed?.provider || base.provider || overlay.provider,
    lastError: currentPrice == null ? overlay.lastError || base.lastError || '' : ''
  };
}

function chooseSeriesPriceSeed(base, overlay) {
  const candidates = [base, overlay].filter((item) => item?.currentPrice != null);
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
  let sourceFallbackApplied = false;

  for (const asin of diffAsins) {
    const seeds = candidateItemsByAsin.get(asin) || [];
    let merged = itemsByAsin.get(asin) || seeds[0];
    for (const seed of seeds) {
      merged = mergeSeriesItemSeed(merged, seed);
    }
    if (merged) itemsByAsin.set(asin, merged);
  }

  if (useSourcePriceFallback && isSeriesUnitPriceSeed(series.sourcePriceSeed)) {
    const fallbackSeed = sourcePriceFallbackSeed(itemsByAsin, series.sourcePriceSeed);
    const sourceFilled = fallbackSeed ? applySourcePriceFallback(itemsByAsin, fallbackSeed) : 0;
    if (sourceFilled > 0) {
      enriched += sourceFilled;
      sourceFallbackApplied = true;
    }
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
      const snapshot = await fetchAmazonHtmlSnapshotForSeriesBackfill(asin);
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

  if (useSourcePriceFallback && !sourceFallbackApplied) {
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

  const items = [...itemsByAsin.values()];
  if (items.length === 0) return false;
  if (items.some((item) => item.currentPrice != null)) return false;

  const sourceProvider = String(series?.sourcePriceSeed?.provider || '').toLowerCase();
  const maxCount =
    sourceProvider === 'amazon_series_unit_price'
      ? floorNumber(process.env.SERIES_UNIT_PRICE_FALLBACK_MAX_COUNT, 1, 200)
      : floorNumber(process.env.SERIES_SOURCE_PRICE_FALLBACK_MAX_COUNT, 1, 12);
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
  if (isSeriesUnitPriceSeed(sourcePriceSeed)) return sourcePriceSeed;

  const representative = pricedItems.find((item) => item.currentPoints != null || item.effectivePrice != null);
  if (!representative) return null;

  return {
    ...sourcePriceSeed,
    currentPoints: representative.currentPoints ?? sourcePriceSeed.currentPoints ?? 0,
    effectivePrice: representative.effectivePrice ?? effectivePriceFromSeed(representative)
  };
}

function isSeriesUnitPriceSeed(sourcePriceSeed) {
  return String(sourcePriceSeed?.provider || '').toLowerCase() === 'amazon_series_unit_price';
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
  return item.currentPrice == null || isWeakSeriesImage(item, weakImageUrls);
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

async function fetchAmazonHtmlSnapshotForSeriesBackfill(asin) {
  const attempts = floorNumber(process.env.SERIES_PRICE_BACKFILL_ATTEMPTS, 1, 2);
  let lastSnapshot = null;
  let lastError = null;

  for (const url of seriesBackfillUrls(asin)) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const snapshot = await fetchAmazonHtmlSnapshot(asin, url);
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
    listPrice: useSnapshotPrice ? snapshot.listPrice ?? item.listPrice ?? null : item.listPrice ?? snapshot.listPrice ?? null,
    provider: useSnapshotPrice ? snapshot.provider || item.provider : item.provider || snapshot.provider,
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
  return ['sale_bon_series', 'kinpome', 'kinpome_series', 'external_series'].includes(String(provider || '').toLowerCase());
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
    book.currentPrice = item.currentPrice;
    book.currentPoints = item.currentPoints ?? 0;
    book.effectivePrice = effectivePrice;
    book.lowestPrice = book.lowestPrice == null ? item.currentPrice : Math.min(book.lowestPrice, item.currentPrice);
    if (effectivePrice != null) {
      book.lowestEffectivePrice =
        book.lowestEffectivePrice == null ? effectivePrice : Math.min(book.lowestEffectivePrice, effectivePrice);
    }
    if (item.listPrice != null && book.listPrice == null) book.listPrice = item.listPrice;
    if (item.provider) book.provider = item.provider;
    book.lastCheckedAt = book.lastCheckedAt || options.now;
    book.lastError = '';
    if (correctingImplausiblePrice) repairImplausibleSeriesPriceHistory(book, options.store);
    changed = true;
  }
  if (book.currentPrice != null && item.currentPrice != null && /価格補完/.test(book.lastError || '')) {
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
  if (/^ASIN\s+[A-Z0-9]{10}$/i.test(book.title || '')) return true;

  const bookVolume = volumeFromSeriesTitle(book.title);
  const itemVolume = seriesItemVolume(item);
  if (bookVolume && itemVolume && bookVolume !== itemVolume) return true;

  return book.provider === 'curated_series' && item.provider && item.provider !== 'curated_series' && book.title !== item.title;
}

function shouldRefreshSeriesPrice(book, item) {
  if (item.currentPrice == null) return false;
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
  if (
    Number.isFinite(listPrice) &&
    listPrice > 0 &&
    isExternalSeriesPriceProvider(item.provider) &&
    String(book.provider || '').toLowerCase() === 'amazon_html' &&
    Number(book.currentPrice) <= listPrice * 0.3 &&
    Number(item.currentPrice) >= Number(book.currentPrice) * 2 &&
    Number(item.currentPrice) <= listPrice * 1.15
  ) {
    return true;
  }
  const currentPoints = Number(book.currentPoints || 0);
  return (
    currentPoints > 0 &&
    currentPoints / Number(book.currentPrice) >= 0.5 &&
    Number(item.currentPrice) >= Number(book.currentPrice) * 2
  );
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
  const currentPrice = Number(book.currentPrice);
  const listPrice = Number(book.listPrice);
  if (!Number.isFinite(floor) || !Number.isFinite(currentPrice) || floor <= 0) return false;
  if (!Number.isFinite(listPrice) || listPrice <= 0) return currentPrice >= floor * 2;
  return floor <= listPrice * 0.3 && currentPrice >= floor * 2 && currentPrice <= listPrice * 1.15;
}

function isImplausibleSeriesHistoryEntry(entry, book) {
  if (String(entry.provider || '').toLowerCase() !== 'amazon_html') return false;
  const historyPrice = Number(entry.price);
  const currentPrice = Number(book.currentPrice);
  const listPrice = Number(book.listPrice);
  if (!Number.isFinite(historyPrice) || !Number.isFinite(currentPrice) || historyPrice <= 0) return false;
  if (!Number.isFinite(listPrice) || listPrice <= 0) return currentPrice >= historyPrice * 2;
  return historyPrice <= listPrice * 0.3 && currentPrice >= historyPrice * 2 && currentPrice <= listPrice * 1.15;
}

function shouldClearUnvalidatedSourcePrice(book, item) {
  return (
    book.provider === 'amazon_series_source_price' &&
    book.currentPrice != null &&
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

  if (options.clearCurrent && suspiciousStoredCurrentPriceReason(book)) {
    book.currentPrice = null;
    book.currentPoints = 0;
    book.effectivePrice = null;
    book.provider = book.provider === 'amazon_html' ? 'pending' : book.provider;
    currentCleared = true;
    changed = true;
  }

  const beforeHistoryCount = store.priceHistory.length;
  store.priceHistory = store.priceHistory.filter(
    (entry) => entry.bookId !== book.id || !isSuspiciousHistoryEntry(entry, book)
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
    (entry) => entry.bookId !== book.id || !isSuspiciousNotificationEntry(entry, book)
  );
  const removedNotifications = beforeNotificationCount - store.notifications.length;
  if (removedNotifications > 0) changed = true;

  if (changed || hasSuspiciousStoredPriceFloor(book)) {
    recomputeBookPriceFloors(book, store);
    changed = true;
  }

  return { changed, currentCleared, currentRestored, removedHistory, removedNotifications };
}

function latestValidPriceHistoryEntry(book, store) {
  return store.priceHistory
    .filter((entry) => entry.bookId === book.id && entry.price != null && !isSuspiciousHistoryEntry(entry, book))
    .sort((a, b) => new Date(b.checkedAt || 0) - new Date(a.checkedAt || 0))[0] || null;
}

function suspiciousStoredCurrentPriceReason(book) {
  return suspiciousPriceReason({
    price: book.currentPrice,
    points: book.currentPoints,
    effectivePrice: book.effectivePrice,
    listPrice: book.listPrice,
    referencePrices: [
      book.listPrice,
      book.previousEffectivePrice,
      book.lowestPrice && Number(book.lowestPrice) !== Number(book.currentPrice) ? book.lowestPrice : null
    ]
  });
}

function isSuspiciousHistoryEntry(entry, book) {
  return Boolean(
    suspiciousPriceReason({
      price: entry.price,
      points: entry.points,
      effectivePrice: entry.effectivePrice,
      listPrice: entry.listPrice ?? book.listPrice,
      referencePrices: [book.currentPrice, book.effectivePrice, book.listPrice]
    })
  );
}

function isSuspiciousNotificationEntry(entry, book) {
  return Boolean(
    suspiciousPriceReason({
      price: entry.effectivePrice,
      points: 0,
      effectivePrice: entry.effectivePrice,
      listPrice: book.listPrice,
      referencePrices: [book.currentPrice, book.effectivePrice, book.listPrice]
    })
  );
}

function hasSuspiciousStoredPriceFloor(book) {
  return Boolean(
    suspiciousPriceReason({
      price: book.lowestPrice,
      points: 0,
      effectivePrice: book.lowestEffectivePrice,
      listPrice: book.listPrice,
      referencePrices: [book.currentPrice, book.effectivePrice, book.listPrice]
    }) ||
      suspiciousPriceReason({
        price: book.lowestEffectivePrice,
        points: 0,
        effectivePrice: book.lowestEffectivePrice,
        listPrice: book.listPrice,
        referencePrices: [book.currentPrice, book.effectivePrice, book.listPrice]
      })
  );
}

function suspiciousPriceReason({ price, points = 0, effectivePrice = null, listPrice = null, referencePrices = [] }) {
  const current = Number(price);
  if (!Number.isFinite(current) || current <= 0) return '';

  const pointValue = Number(points || 0);
  if (Number.isFinite(pointValue) && pointValue > current) return 'ポイントが価格を超えています';

  const list = Number(listPrice);
  if (Number.isFinite(list) && list > 0 && current > list * 1.15) return '価格が定価を大きく超えています';

  const reference = Math.max(
    ...referencePrices
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  const lowPriceMax = floorNumber(process.env.SUSPICIOUS_LOW_PRICE_MAX, 1, 60);
  if (Number.isFinite(reference) && current <= lowPriceMax && reference >= current * 3) {
    return '割引率またはポイントを価格として読んだ可能性があります';
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

function recomputeBookPriceFloors(book, store) {
  const entries = store.priceHistory.filter((entry) => entry.bookId === book.id && entry.price != null);
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
  if (normalized === 'amazon_series_bulk') return 95;
  if (normalized === 'amazon_series_unit_price') return 90;
  if (normalized === 'amazon_series_reader') return 70;
  if (normalized === 'sale_bon_series') return 80;
  if (normalized === 'kinpome') return 78;
  if (normalized === 'kinpome_series') return 75;
  if (normalized === 'amazon_series_source_price') return 60;
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
    'amazon_series_reader',
    'amazon_series_bulk',
    'amazon_series_unit_price',
    'sale_bon_series',
    'kinpome',
    'kinpome_series',
    'amazon_series_source_price',
    'external_series'
  ].includes(String(provider || '').toLowerCase());
}

function seriesImageProviderRank(provider) {
  const normalized = String(provider || '').toLowerCase();
  if (normalized === 'keepa' || normalized === 'amazon_html') return 100;
  if (normalized === 'amazon_reader') return 90;
  if (normalized === 'amazon_series_reader') return 85;
  if (normalized === 'external_series') return 80;
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

  for (const book of books) {
    if (!isKnownBookForSeries(book, options) || merged.has(book.asin)) continue;
    merged.set(book.asin, seedFromExistingBook(book));
  }

  return [...merged.values()].sort(compareSeriesItemSeeds);
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
    store.notifications = store.notifications.filter((entry) => !targetIds.has(entry.bookId));
    resetCursorIfDeleted(store, targetIds);
    return store;
  });
}

export async function getHistory(bookId) {
  const store = await readStore();
  return store.priceHistory
    .filter((entry) => entry.bookId === bookId)
    .sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt));
}

export async function checkBookById(id, options = {}) {
  const store = await readStore();
  const book = store.books.find((item) => item.id === id);
  if (!book) {
    const error = new Error('本が見つかりません');
    error.status = 404;
    throw error;
  }
  return checkOneBook(book, options);
}

export async function runDueChecks(options = {}) {
  const source = options.source || 'manual';
  const cronStartedAt = new Date().toISOString();
  if (source === 'cron') {
    await recordCronRun({
      lastCronStartedAt: cronStartedAt,
      lastCronError: ''
    });
  }

  try {
    const startedAt = Date.now();
    const maxRuntimeMs = floorNumber(process.env.CHECK_MAX_RUNTIME_MS, 0, 0);
    const seriesDiscovery = shouldRunSeriesDiscovery(source, options)
      ? await discoverSeriesUpdates({ startedAt, maxRuntimeMs })
      : null;
    const store = await readStore();
    const settings = mergedRuntimeSettings(store.settings);
    const forceAll = options.force === true || readEnvBoolean('FORCE_CHECK_ALL', false);
    const plan = planDueChecks(store, settings, startedAt, { forceAll });
    const pacing = checkPacing();
    const getWebhookUrls = options.notify === false ? null : sharedWebhookUrlLoader();

    const results = [];
    let stoppedByRuntimeLimit = false;
    for (let index = 0; index < plan.books.length; index += 1) {
      if (shouldStopForRuntimeLimit(startedAt, maxRuntimeMs, results.length)) {
        stoppedByRuntimeLimit = true;
        break;
      }

      if (!(await waitBeforeCheck(pacing, results.length, startedAt, maxRuntimeMs))) {
        stoppedByRuntimeLimit = true;
        break;
      }

      const book = plan.books[index];
      const result = await checkOneBook(book, { ...options, updateCursor: false, getWebhookUrls });
      results.push(result);
      await recordCursorForCompletedBook(book, result);

      if (isBlockingCheckResult(result)) {
        if (!(await waitAfterBlockedCheck(pacing, startedAt, maxRuntimeMs))) {
          stoppedByRuntimeLimit = true;
          break;
        }
      }
    }

    const finalStore = await readStore();
    const remainingDue = countDueBooks(finalStore.books, Date.now(), settings);
    const result = {
      checked: results.length,
      remainingDue,
      cursor: finalStore.checkCursor,
      overlapped: Math.max(0, results.length - plan.dueSelected),
      stoppedByRuntimeLimit,
      forced: forceAll,
      seriesDiscovery,
      results
    };

    if (source === 'cron') {
      await recordCronRun({
        lastCronFinishedAt: new Date().toISOString(),
        lastCronChecked: result.checked,
        lastCronRemainingDue: result.remainingDue,
        lastCronStoppedByRuntimeLimit: result.stoppedByRuntimeLimit,
        lastSeriesDiscoveryChecked: seriesDiscovery?.checked || 0,
        lastSeriesDiscoveryAdded: seriesDiscovery?.added || 0,
        lastSeriesDiscoveryCompleted: seriesDiscovery?.completed || 0,
        lastSeriesDiscoveryErrors: seriesDiscovery?.errors?.length || 0,
        lastCronError: ''
      });
    }

    return result;
  } catch (error) {
    if (source === 'cron') {
      await recordCronRun({
        lastCronFinishedAt: new Date().toISOString(),
        lastCronError: error.message || String(error)
      });
    }
    throw error;
  }
}

async function discoverSeriesUpdates(options = {}) {
  const now = new Date().toISOString();
  const store = await readStore();
  const plan = planSeriesDiscovery(store);
  const pacing = seriesDiscoveryPacing();
  const results = [];
  const errors = [];
  let added = 0;
  let completed = 0;
  let stoppedByRuntimeLimit = false;

  for (const group of plan.groups) {
    if (shouldStopSeriesDiscoveryForRuntimeLimit(options.startedAt, options.maxRuntimeMs, results.length + errors.length)) {
      stoppedByRuntimeLimit = true;
      break;
    }

    try {
      if (!(await waitBeforeSeriesDiscovery(pacing, results.length + errors.length, options.startedAt, options.maxRuntimeMs))) {
        stoppedByRuntimeLimit = true;
        break;
      }

      const result = await addBooksFromInput(seriesDiscoveryInput(group.sourceUrl, group.seriesKey));
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
      await recordSeriesDiscoveryCursor(group, now);
    } catch (error) {
      const message = error.message || String(error);
      errors.push({
        seriesKey: group.seriesKey,
        seriesName: group.seriesName,
        error: message
      });
      await markSeriesDiscoveryError(group, now, message);
      await recordSeriesDiscoveryCursor(group, now);
    }
  }

  return {
    checked: results.length + errors.length,
    added,
    completed,
    stoppedByRuntimeLimit,
    cursor: (await readStore()).seriesDiscoveryCursor,
    results,
    errors
  };
}

function shouldRunSeriesDiscovery(source, options = {}) {
  if (options.discoverSeries === true) return true;
  if (options.discoverSeries === false) return false;
  return source === 'cron' || source === 'scheduler';
}

function planSeriesDiscovery(store) {
  const groups = rotateSeriesGroupsAfterCursor(
    seriesDiscoveryGroups(store.books),
    store.seriesDiscoveryCursor?.lastSeriesKey
  );
  const limit = floorNumber(process.env.SERIES_DISCOVERY_BATCH_SIZE, 1, 50);
  return { groups: groups.slice(0, limit), totalEligible: groups.length };
}

function seriesDiscoveryGroups(books = []) {
  const groups = new Map();

  for (const book of books) {
    if (book.importMode !== 'kindle_series' && !book.seriesKey) continue;
    const seriesKey = book.seriesKey || book.sourceUrl;
    const sourceUrl = book.sourceUrl || seriesInputFromSeriesKey(seriesKey);
    if (!seriesKey || !sourceUrl) continue;

    if (!groups.has(seriesKey)) {
      groups.set(seriesKey, {
        seriesKey,
        sourceUrl,
        seriesName: book.seriesName || seriesTitleFromBook(book),
        completed: false,
        books: []
      });
    }

    const group = groups.get(seriesKey);
    group.books.push(book);
    group.completed = group.completed || Boolean(book.seriesCompleted);
  }

  return [...groups.values()].filter((group) => !group.completed);
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

function shouldStopSeriesDiscoveryForRuntimeLimit(startedAt, maxRuntimeMs, completedCount) {
  return maxRuntimeMs > 0 && completedCount > 0 && Date.now() - startedAt >= maxRuntimeMs;
}

async function markSeriesDiscoveryError(group, now, error) {
  await updateStore((store) => {
    for (const book of store.books) {
      if (book.seriesKey !== group.seriesKey) continue;
      applySeriesDiscoveryMetadata(book, { now, error });
    }
    return store;
  });
}

async function recordSeriesDiscoveryCursor(group, now) {
  await updateStore((store) => {
    store.seriesDiscoveryCursor = {
      lastSeriesKey: group.seriesKey,
      checkedAt: now
    };
    return store;
  });
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
    discordConfigured: webhooks.count > 0,
    discordWebhookCount: webhooks.count
  };
}

export async function saveSettings(settings) {
  const cleaned = {
    notificationThreshold: clampNumber(settings.notificationThreshold, 0, 95, 10),
    checkIntervalHours: normalizeCheckIntervalHours(settings.checkIntervalHours, 24),
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
  const dedicated = storedDiscordWebhookUrls(webhookStore);
  if (dedicated != null) {
    return {
      urls: dedicated,
      count: dedicated.length,
      usingEnvFallback: false,
      source: 'webhook_store'
    };
  }

  const store = await readStore();
  const stored = storedDiscordWebhookUrls(store.settings);
  const urls = stored ?? getDiscordWebhookUrls();
  return {
    urls,
    count: urls.length,
    usingEnvFallback: stored == null,
    source: stored == null ? 'env' : 'legacy_settings'
  };
}

export async function saveDiscordWebhooks(urls) {
  const cleaned = normalizeDiscordWebhookUrls(urls);
  await writeWebhookStore(cleaned);
  await updateStore((store) => {
    store.settings = {
      ...store.settings,
      discordWebhookUrls: cleaned
    };
    return store;
  });
  return {
    urls: cleaned,
    count: cleaned.length,
    usingEnvFallback: false,
    source: 'webhook_store'
  };
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

function normalizeDiscordWebhookUrls(urls) {
  const parsed = parseDiscordWebhookUrls(Array.isArray(urls) ? urls.join('\n') : String(urls || ''));
  for (const url of parsed) {
    if (!isValidDiscordWebhookUrl(url)) {
      const error = new Error('Discord Webhook URL の形式が正しくありません');
      error.status = 400;
      throw error;
    }
  }
  return parsed;
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
  const snapshotResult = await settleSnapshot(bookRef.asin, bookRef);

  let checkedBook;
  let events = [];
  let settings;

  await updateStore((store) => {
    settings = mergedRuntimeSettings(store.settings);
    const book = store.books.find((item) => item.id === bookRef.id);
    if (!book) return store;

    const previousEffectivePrice = book.effectivePrice;
    const previousLowestEffectivePrice = book.lowestEffectivePrice;

    if (!snapshotResult.ok) {
      if (snapshotResult.snapshot) {
        applyMetadataSnapshotToBook(book, snapshotResult.snapshot);
      }
      const repair = repairSuspiciousPriceState(book, store, {
        clearCurrent: true,
        restoreMissingCurrent: true
      });
      if (
        isUnresolvedSingleBook(book) ||
        (repair.currentCleared && !repair.currentRestored) ||
        isSuspiciousSnapshotError(snapshotResult.error)
      ) {
        book.lastCheckedAt = null;
      } else if (!repair.currentRestored) {
        book.lastCheckedAt = now;
      }
      book.updatedAt = now;
      book.lastError = snapshotResult.error;
      if (options.updateCursor) updateCheckCursor(store, book, now);
      checkedBook = { ...book };
      return store;
    }

    const snapshot = snapshotResult.snapshot;
    book.title = preferSnapshotText(snapshot.title, book.title);
    book.author = snapshot.author || book.author;
    book.publisher = snapshot.publisher || book.publisher;
    book.imageUrl = snapshot.imageUrl || book.imageUrl;
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
      store.priceHistory.push(historyEntry(book, now));
    }
    repairSuspiciousPriceState(book, store);

    events = detectEvents({
      book,
      previousEffectivePrice,
      previousLowestEffectivePrice,
      settings
    }).filter((event) => !alreadyNotified(store, book.id, event));

    for (const event of events) {
      store.notifications.push({
        id: crypto.randomUUID(),
        bookId: book.id,
        asin: book.asin,
        type: event.type,
        effectivePrice: book.effectivePrice,
        previousEffectivePrice,
        createdAt: now,
        status: 'pending'
      });
    }

    checkedBook = { ...book };
    return store;
  });

  const sent = [];
  if (options.notify !== false && checkedBook && events.length > 0) {
    const webhookUrls = await notificationWebhookUrls(options);
    for (const event of events) {
      const notification = buildPriceNotification(checkedBook, event);
      try {
        await sendDiscordNotification(notification, { webhookUrls });
        sent.push({ type: event.type, ok: true });
        await markNotification(checkedBook.id, event, 'sent');
      } catch (error) {
        sent.push({ type: event.type, ok: false, error: error.message });
        await markNotification(checkedBook.id, event, 'failed', error.message);
      }
    }
  }

  return {
    book: checkedBook ? publicBook(checkedBook) : null,
    ok: snapshotResult.ok,
    error: snapshotResult.ok ? null : snapshotResult.error,
    events,
    notifications: sent
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

async function settleSnapshot(asin, book = {}) {
  try {
    const snapshot = await fetchBookSnapshot(asin, { url: book.sourceUrl || book.amazonUrl || '' });
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
    const snapshot = await fetchBookSnapshot(asin, { url });
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
  const now = options.createdAt || new Date().toISOString();
  let snapshot;
  let lastError = '';

  if (fetchDetails) {
    try {
      snapshot = await fetchBookSnapshot(asin, { url: options.inputUrl || seed.amazonUrl || '' });
    } catch (error) {
      lastError = error.message;
    }
  } else {
    lastError = seed.currentPrice == null ? seed.lastError || 'シリーズ一括登録: 次回チェックで詳細取得します' : '';
  }

  const fallback = {
    asin,
    title: seed.title || `ASIN ${asin}`,
    author: seed.author || '',
    publisher: seed.publisher || '',
    imageUrl: seed.imageUrl || '',
    imageSource: seed.imageSource || '',
    amazonUrl: seed.amazonUrl || amazonUrlForAsin(asin),
    currentPrice: seed.currentPrice ?? null,
    currentPoints: seed.currentPoints ?? 0,
    effectivePrice: seed.effectivePrice ?? effectivePriceFromSeed(seed),
    listPrice: seed.listPrice ?? null,
    provider: seed.provider || (fetchDetails ? 'pending' : 'pending_series')
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

async function markNotification(bookId, event, status, error = '') {
  await updateStore((store) => {
    const notification = [...store.notifications]
      .reverse()
      .find(
        (item) =>
          item.bookId === bookId &&
          item.type === event.type &&
          item.effectivePrice === event.effectivePrice &&
          item.status === 'pending'
      );

    if (notification) {
      notification.status = status;
      notification.error = error;
      notification.sentAt = new Date().toISOString();
    }

    return store;
  });
}

function planDueChecks(store, settings, now, options = {}) {
  const rotatedBooks = rotateAfterCursor(store.books, store.checkCursor?.lastBookId);
  if (options.forceAll) {
    const selected = rotatedBooks.slice(0, settings.batchSize);
    return { books: selected, dueSelected: selected.length };
  }

  const dueBefore = now - settings.checkIntervalHours * 60 * 60 * 1000;
  const dueBooks = rotatedBooks.filter((book) => isBookDue(book, dueBefore));
  const selected = dueBooks.slice(0, settings.batchSize);
  const dueSelected = selected.length;

  if (dueBooks.length > 0 && selected.length < settings.batchSize) {
    const selectedIds = new Set(selected.map((book) => book.id));
    for (const book of rotatedBooks) {
      if (selected.length >= settings.batchSize) break;
      if (selectedIds.has(book.id) || isBookDue(book, dueBefore)) continue;
      selected.push(book);
      selectedIds.add(book.id);
    }
  }

  return { books: selected, dueSelected };
}

function rotateAfterCursor(books, lastBookId = '') {
  if (!Array.isArray(books) || books.length === 0) return [];
  const cursorIndex = books.findIndex((book) => book.id === lastBookId);
  if (cursorIndex === -1 || cursorIndex === books.length - 1) return [...books];
  return [...books.slice(cursorIndex + 1), ...books.slice(0, cursorIndex + 1)];
}

function countDueBooks(books, now, settings) {
  const dueBefore = now - settings.checkIntervalHours * 60 * 60 * 1000;
  return books.filter((book) => isBookDue(book, dueBefore)).length;
}

function isBookDue(book, dueBefore) {
  if (!book.lastCheckedAt) return true;
  const checkedAt = new Date(book.lastCheckedAt).getTime();
  return !Number.isFinite(checkedAt) || checkedAt <= dueBefore;
}

function shouldStopForRuntimeLimit(startedAt, maxRuntimeMs, completedCount) {
  return maxRuntimeMs > 0 && completedCount > 0 && Date.now() - startedAt >= maxRuntimeMs;
}

function readEnvBoolean(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

async function recordCursorForCompletedBook(bookRef, result) {
  const checkedBook = result?.book || bookRef;
  if (!checkedBook?.id) return;

  await updateStore((store) => {
    const book = store.books.find((item) => item.id === checkedBook.id);
    if (book) updateCheckCursor(store, book, checkedBook.lastCheckedAt || book.lastCheckedAt || new Date().toISOString());
    return store;
  });
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

async function waitBeforeCheck(pacing, completedCount, startedAt, maxRuntimeMs) {
  if (completedCount === 0) return true;
  return sleepWithinRuntime(randomizedDelay(pacing.delayMs, pacing.jitterMs), startedAt, maxRuntimeMs);
}

async function waitAfterBlockedCheck(pacing, startedAt, maxRuntimeMs) {
  return sleepWithinRuntime(randomizedDelay(pacing.blockCooldownMs, Math.floor(pacing.blockCooldownMs / 3)), startedAt, maxRuntimeMs);
}

async function waitBeforeSeriesDiscovery(pacing, completedCount, startedAt, maxRuntimeMs) {
  if (completedCount === 0) return true;
  return sleepWithinRuntime(randomizedDelay(pacing.delayMs, pacing.jitterMs), startedAt, maxRuntimeMs);
}

async function sleepWithinRuntime(ms, startedAt, maxRuntimeMs) {
  const delay = Math.max(0, Math.round(ms || 0));
  if (delay === 0) return true;

  if (maxRuntimeMs > 0) {
    const remaining = maxRuntimeMs - (Date.now() - startedAt);
    if (remaining <= delay + 1000) return false;
  }

  await sleep(delay);
  return true;
}

function randomizedDelay(baseMs, jitterMs) {
  const base = Math.max(0, Math.round(baseMs || 0));
  const jitter = Math.max(0, Math.round(jitterMs || 0));
  return base + (jitter > 0 ? Math.floor(Math.random() * (jitter + 1)) : 0);
}

function isBlockingCheckResult(result) {
  const value = String(result?.error || result?.book?.lastError || '');
  return /(?:HTTP\s*(?:429|503)|Too Many Requests|ServiceUnavailable|サービスが利用できません|Amazonにブロック|captcha|robot check|自動化されたアクセス|ショッピングを続けてください)/i.test(value);
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

async function recordCronRun(fields) {
  await updateStore((store) => {
    store.automation = {
      ...(store.automation || {}),
      ...fields
    };
    return store;
  });
}

function mergedRuntimeSettings(settings = {}) {
  return {
    notificationThreshold: clampNumber(settings.notificationThreshold, 0, 95, 10),
    checkIntervalHours: normalizeCheckIntervalHours(settings.checkIntervalHours, 24),
    batchSize: floorNumber(settings.batchSize, 1, 50),
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

function normalizeCheckIntervalHours(value, fallback = 24) {
  const allowed = [24, 48, 72];
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  return allowed.includes(rounded) ? rounded : fallback;
}

function sortBooks(a, b) {
  const aTime = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
  const bTime = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
  return aTime - bTime;
}
