import crypto from 'node:crypto';
import { amazonUrlForAsin, extractAsin, isKindleSeriesUrl } from './amazon-url.mjs';

const ASIN_GLOBAL_PATTERN = /[A-Z0-9]{10}/gi;
const DEFAULT_FETCH_TIMEOUT_MS = 4000;
const IMPLICIT_TINY_KINDLE_PRICE_MAX = 99;
const HOST_THROTTLES = new Map();

const AMAZON_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
  'Cache-Control': 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
};
const AMAZON_USER_AGENTS = [
  AMAZON_HEADERS['User-Agent'],
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0'
];
const SERIES_COMPLETION_OVERRIDES = [
  { sourceAsin: 'B075FTFV56', names: ['ピンポン'], expectedVolumeCount: 5, completed: true },
  { sourceAsin: 'B0756XMNQ5', names: ['火の鳥'], expectedVolumeCount: 16, completed: true },
  { sourceAsin: 'B074CJS8RT', names: ['ホットロード'], expectedVolumeCount: 4, completed: true },
  { sourceAsin: 'B07876DFH4', names: ['亜獣譚'], expectedVolumeCount: 8, completed: true },
  { sourceAsin: 'B075V4W6R3', names: ['羊のうた'], expectedVolumeCount: 7, completed: true },
  { sourceAsin: 'B013WFXD5I', names: ['花男'], expectedVolumeCount: 3, completed: true },
  { sourceAsin: 'B075P5J6VW', names: ['預言者ピッピ'], expectedVolumeCount: 2, completed: false }
].map((entry) => ({
  ...entry,
  normalizedNames: entry.names.map((name) => normalizeSeriesCompletionOverrideName(name))
}));

export { amazonUrlForAsin, extractAsin, isKindleSeriesUrl };

export async function fetchKindleSeriesItems(input, options = {}) {
  const inputAsin = extractAsin(input);
  let amazonResult = null;
  let amazonError = null;
  const attemptedUrls = new Set();

  while (shouldTryAmazonSeriesHtmlCandidate(amazonResult, amazonError, input, attemptedUrls)) {
    try {
      const candidate = await fetchAmazonSeriesResultFromNextHtml(input, inputAsin, options, attemptedUrls);
      if (isBetterKindleSeriesResult(candidate, amazonResult) || !amazonResult) {
        amazonResult = candidate;
      }
      amazonError = null;
    } catch (error) {
      amazonError = error;
      break;
    }
  }

  if (options.allowReaderFallback !== false && shouldTryAmazonSeriesReaderFallback(amazonResult, amazonError, input)) {
    try {
      const readerResult = await fetchKindleSeriesItemsFromAmazonReader(input, options);
      if (isBetterKindleSeriesResult(readerResult, amazonResult)) return readerResult;
    } catch (error) {
      if (!amazonResult) amazonError = error;
    }
  }

  if (amazonResult) return amazonResult;
  throw amazonError || new Error('Amazonシリーズページを取得できませんでした');
}

async function fetchAmazonSeriesResultFromNextHtml(input, inputAsin, options, attemptedUrls) {
  const { url, html } = await fetchAmazonSeriesHtml(input, options, attemptedUrls);
  let items = extractKindleSeriesItemsFromHtml(html);
  items = await enrichKindleSeriesItemsFromChildListPages(items, html, url, options);
  const sourceAsin = extractSeriesCollectionAsin(html, inputAsin, items);
  if (sourceAsin && inputAsin && sourceAsin !== inputAsin) {
    try {
      const collectionResult = await fetchAmazonSeriesResultFromNextHtml(
        kindleSeriesFetchUrlForAsin(sourceAsin),
        sourceAsin,
        options,
        attemptedUrls
      );
      if (collectionResult?.items?.length > 1) return collectionResult;
    } catch {
      // Continue with the original page if the collection page cannot be loaded.
    }
  }

  if (options.requireCollectionPage && !isKindleCollectionPage(html, sourceAsin, items)) {
    items = [];
  }

  return withSeriesCompletionProbe(buildKindleSeriesResult({
    seriesName: extractSeriesName(html),
    sourceAsin,
    sourcePriceSeed: extractSeriesSourcePriceSeedFromHtml(html, sourceAsin, url, items),
    expectedVolumeCount: extractSeriesExpectedCount(html) || maxSeriesItemVolume(items) || items.length,
    completed: extractSeriesCompletionStatus(html),
    items
  }), options);
}

function shouldTryAmazonSeriesHtmlCandidate(series, error, input, attemptedUrls) {
  const urls = kindleSeriesCandidateUrls(input);
  if (attemptedUrls.size >= urls.length) return false;
  if (!series) return true;
  if (error) return true;
  if (!isKindleDbsProductUrl(input)) return false;
  const items = Array.isArray(series.items) ? series.items : [];
  if (items.length <= 1) return true;
  const expected = Number(series.expectedVolumeCount) || 0;
  return expected > items.length;
}

function buildKindleSeriesResult(series) {
  const limit = readPositiveInteger(process.env.SERIES_IMPORT_LIMIT, null);
  const items = normalizeKindleSeriesItemVolumes((series.items || []).filter(isUsableKindleSeriesItem));
  return applyKnownSeriesCompletionOverride({
    ...series,
    items: limit == null ? items : items.slice(0, limit)
  });
}

export function applyKnownSeriesCompletionOverride(series = {}) {
  const override = knownSeriesCompletionOverrideFor(series);
  if (!override) return series;
  const source = override.completed ? 'curated_series_completion' : 'curated_series_incomplete';

  return {
    ...series,
    completed: override.completed,
    completionSource: source,
    completionOverride: source
  };
}

function isUsableKindleSeriesItem(item = {}) {
  if (!item?.asin || !isProbablyBookAsin(item.asin)) return false;
  const title = cleanText(item.title);
  if (!title) return true;
  if (isSeriesNavigationPseudoTitle(title)) return false;
  if (isAmazonRatingOrReviewTitle(title)) return false;
  return true;
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

async function withSeriesCompletionProbe(series, options = {}) {
  if (isKnownSeriesCompletionOverride(series, false)) return applyKnownSeriesCompletionOverride(series);
  if (series?.completed || options.probeSeriesCompletion === false) return series;
  if (!Array.isArray(series?.items) || series.items.length <= 1) return series;

  try {
    const evidence = await fetchMangaZenkanCompletionEvidence(series, options);
    if (evidence?.completed) {
      return {
        ...series,
        completed: true,
        completionSource: evidence.source
      };
    }
  } catch {
    // External web evidence is optional.
  }

  const finalItem = highestVolumeSeriesItem(series.items);
  if (!finalItem?.asin) return series;

  try {
    const url = finalItem.amazonUrl || amazonUrlForAsin(finalItem.asin);
    const html = await fetchAmazonHtml(url, options);
    if (!extractSeriesCompletionStatus(html)) return series;
    return {
      ...series,
      completed: true,
      completionSource: 'final_volume_description'
    };
  } catch {
    return series;
  }
}

function knownSeriesCompletionOverrideFor(series = {}) {
  const sourceAsin = String(series.sourceAsin || extractAsin(series.sourceUrl) || '').toUpperCase();
  const items = Array.isArray(series.items) ? series.items : [];
  const expectedVolumeCount = Math.max(
    Number(series.expectedVolumeCount) || 0,
    maxSeriesItemVolume(items),
    items.length
  );
  const normalizedName = normalizeSeriesCompletionOverrideName(series.seriesName);

  return SERIES_COMPLETION_OVERRIDES.find((override) => {
    if (sourceAsin && sourceAsin === override.sourceAsin) return true;
    if (!normalizedName || !override.normalizedNames.includes(normalizedName)) return false;
    return !override.expectedVolumeCount || expectedVolumeCount === override.expectedVolumeCount;
  }) || null;
}

function isKnownSeriesCompletionOverride(series = {}, completed) {
  const override = knownSeriesCompletionOverrideFor(series);
  return Boolean(override && override.completed === completed);
}

function normalizeSeriesCompletionOverrideName(value) {
  return normalizeSeriesNameForMatch(value);
}

function highestVolumeSeriesItem(items = []) {
  return [...items].sort((left, right) => {
    const leftVolume = seriesItemVolume(left);
    const rightVolume = seriesItemVolume(right);
    if (leftVolume !== rightVolume) return rightVolume - leftVolume;
    return String(right.asin || '').localeCompare(String(left.asin || ''));
  })[0] || null;
}

function seriesItemVolume(item = {}) {
  const direct = Number(item.volume);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return Number(toHalfWidthNumber(String(item.title || '').match(/(?:第)?([0-9０-９]{1,3})\s*巻/)?.[1] || '')) || 0;
}

async function fetchMangaZenkanCompletionEvidence(series, options = {}) {
  if (options.probeExternalCompletion === false) return null;
  if (String(process.env.SERIES_COMPLETION_WEB_PROBE || 'true').toLowerCase() === 'false') return null;

  const seriesName = cleanTitle(series?.seriesName || '');
  const expectedVolumeCount = Number(series?.expectedVolumeCount) || maxSeriesItemVolume(series?.items || []);
  if (!seriesName || seriesName === 'Kindle シリーズ' || expectedVolumeCount <= 1) return null;

  const url = `https://www.mangazenkan.com/s/?mode=search&name=${encodeURIComponent(seriesName)}`;
  const html = await fetchHtml(url, {
    ...options,
    retries: options.retries ?? process.env.HTTP_EXTERNAL_FETCH_RETRIES ?? 1,
    retryDelayMs: options.retryDelayMs ?? process.env.HTTP_FETCH_RETRY_DELAY_MS ?? 1000,
    throttleUrl: url
  });
  return extractMangaZenkanCompletionEvidence(html, seriesName, expectedVolumeCount);
}

function normalizeKindleSeriesItemVolumes(items) {
  return items.map((item, index) => ({
    ...item,
    volume: item.volume || extractExternalVolumeFromTitle(item.title) || String(index + 1)
  }));
}

function shouldTryAmazonSeriesReaderFallback(series, error, input = '') {
  if (!shouldUseAmazonReaderFallback()) return false;
  if (error || !series) return true;
  if (!Array.isArray(series.items) || series.items.length <= 1) return true;

  const expected = Number(series.expectedVolumeCount) || 0;
  return expected > series.items.length || isPotentiallyPartialCompletedKindleDbsSeries(series, input);
}

function isPotentiallyPartialCompletedKindleDbsSeries(series = {}, input = '') {
  if (!series.completed || !isKindleDbsProductUrl(input)) return false;

  const items = Array.isArray(series.items) ? series.items : [];
  if (items.length < 2 || items.length > 4) return false;

  const expected = Number(series.expectedVolumeCount) || 0;
  return expected === 0 || expected <= items.length;
}

function isBetterKindleSeriesResult(candidate, current) {
  if (!candidate?.items?.length) return false;
  if (!current?.items?.length) return true;
  if (candidate.items.length > current.items.length) return true;

  const candidateExpected = Number(candidate.expectedVolumeCount) || 0;
  const currentExpected = Number(current.expectedVolumeCount) || 0;
  if (candidateExpected > currentExpected && candidate.items.length >= candidateExpected) return true;
  return false;
}

async function fetchAmazonSeriesHtml(input, options = {}, attemptedUrls = new Set()) {
  const urls = kindleSeriesCandidateUrls(input);
  let lastError;

  for (const url of urls) {
    if (attemptedUrls.has(url)) continue;
    attemptedUrls.add(url);
    try {
      return { url, html: await fetchAmazonHtml(url, options) };
    } catch (error) {
      lastError = error;
      if (isAmazonBlockingFetchError(error) && !shouldContinueAfterBlockedKindleDbsUrl(url)) break;
    }
  }

  throw lastError || new Error('Amazonシリーズページを取得できませんでした');
}

function shouldContinueAfterBlockedKindleDbsUrl(url) {
  return isKindleDbsProductUrl(url);
}

function shouldSkipBlockingPenalty(url, responseLike = {}) {
  return isKindleDbsProductUrl(url) && isBlockingHttpStatus(responseLike.status);
}

async function enrichKindleSeriesItemsFromChildListPages(items, html, sourceUrl, options = {}) {
  if (options.fetchSeriesChildPages === false) return items;

  const pagination = extractSeriesAsinListPagination(html, sourceUrl);
  if (!pagination) return items;

  const childItems = extractChildAsinListItems(html);
  if (childItems.length >= pagination.totalItems) return items;

  const maxItems = readPositiveInteger(process.env.AMAZON_SERIES_SHOW_ALL_LIMIT, 250);
  if (pagination.totalItems > maxItems) return mergeSeriesItemsWithChildItems(items, childItems);

  try {
    const allChildItems = await fetchAmazonSeriesAllChildItems(pagination, sourceUrl, options);
    return mergeSeriesItemsWithChildItems(items, allChildItems.length > childItems.length ? allChildItems : childItems);
  } catch {
    return mergeSeriesItemsWithChildItems(items, childItems);
  }
}

async function fetchAmazonSeriesAllChildItems(pagination, sourceUrl, options = {}) {
  const url = amazonSeriesAsinListAjaxUrl(pagination, sourceUrl);
  const html = await fetchAmazonSeriesAjaxHtml(url, sourceUrl, options);
  return extractChildAsinListItems(html);
}

function extractSeriesAsinListPagination(html, sourceUrl = '') {
  const value = String(html || '');
  const tag = value.match(/<div\b[^>]*id=["']seriesAsinListPagination["'][^>]*>/i)?.[0] || '';
  if (!tag) return null;

  const asin = (extractAttribute(tag, 'data-asin') || extractAsin(sourceUrl) || '').toUpperCase();
  const totalItems = readPositiveInteger(extractAttribute(tag, 'data-number_of_items'), 0);
  const pageSize = readPositiveInteger(extractAttribute(tag, 'data-page_size'), 0);
  const requestId = extractSeriesMainPageRequestId(value);
  if (!isProbablyBookAsin(asin) || totalItems <= 0 || pageSize <= 0 || !requestId) return null;

  return {
    asin,
    binding: extractAttribute(tag, 'data-binding') || 'kindle_edition',
    currentPage: readPositiveInteger(extractAttribute(tag, 'data-current_page'), 1),
    pageSize,
    qid: extractAttribute(tag, 'data-qid'),
    requestId,
    sr: extractAttribute(tag, 'data-sr'),
    totalItems
  };
}

function extractSeriesMainPageRequestId(html) {
  const value = String(html || '');
  const state = value.match(/<script\b[^>]*data-a-state=["'][^"']*SeriesMainPageRequestId[^"']*["'][^>]*>([\s\S]*?)<\/script>/i);
  if (state) {
    const body = decodeHtml(state[1]);
    try {
      const parsed = JSON.parse(body);
      if (parsed?.requestId) return String(parsed.requestId);
    } catch {
      const requestId = body.match(/["']requestId["']\s*:\s*["']([^"']+)["']/i)?.[1];
      if (requestId) return requestId;
    }
  }

  return value.match(/SeriesMainPageRequestId[\s\S]{0,400}?["']requestId["']\s*:\s*["']([^"']+)["']/i)?.[1] || '';
}

function amazonSeriesAsinListAjaxUrl(pagination, sourceUrl = '') {
  const origin = amazonOrigin(sourceUrl);
  const url = new URL('/kindle-dbs/productPage/ajax/seriesAsinList', origin);
  url.searchParams.set('asin', pagination.asin);
  url.searchParams.set('pageNumber', '1');
  url.searchParams.set('pageSize', String(pagination.totalItems));
  url.searchParams.set('relatedRequestId', pagination.requestId);
  url.searchParams.set('binding', pagination.binding || 'kindle_edition');
  url.searchParams.set('ref_', 'series_dp_batch_load_all');
  if (pagination.qid) url.searchParams.set('qid', pagination.qid);
  if (pagination.sr) url.searchParams.set('sr', pagination.sr);
  return url.toString();
}

function amazonOrigin(sourceUrl = '') {
  try {
    const url = new URL(String(sourceUrl || ''));
    if (/amazon\./i.test(url.hostname)) return `${url.protocol}//${url.hostname}`;
  } catch {
    // Fall back to the configured Amazon host.
  }
  const host = process.env.AMAZON_HOST || 'www.amazon.co.jp';
  return `https://${host}`;
}

async function fetchAmazonSeriesAjaxHtml(url, refererUrl, options = {}) {
  return fetchHtml(url, {
    ...options,
    headers: amazonAjaxRequestHeaders(url, refererUrl),
    proxyTemplate: process.env.AMAZON_HTML_PROXY_URL_TEMPLATE,
    rejectRobotCheck: true,
    retries: options.retries ?? process.env.HTTP_AMAZON_FETCH_RETRIES ?? 1,
    retryDelayMs: options.retryDelayMs ?? process.env.HTTP_FETCH_RETRY_DELAY_MS ?? 1000,
    throttleUrl: refererUrl || url
  });
}

function amazonAjaxRequestHeaders(url, refererUrl = '') {
  const headers = {
    ...amazonRequestHeaders(refererUrl || url),
    Accept: 'text/html,*/*',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Requested-With': 'XMLHttpRequest'
  };
  delete headers['Sec-Fetch-User'];
  delete headers['Upgrade-Insecure-Requests'];
  if (refererUrl) headers.Referer = refererUrl;
  return headers;
}

function kindleSeriesCandidateUrls(input) {
  const urls = [];
  const add = (value) => {
    if (!value || urls.includes(value)) return;
    urls.push(value);
  };

  add(normalizeAmazonUrl(input));

  const asin = extractAsin(input);
  if (asin) {
    const host = process.env.AMAZON_HOST || 'www.amazon.co.jp';
    add(`https://${host}/dp/${asin}`);
    add(`https://${host}/dp/${asin}?binding=kindle_edition&ref_=dbs_s_ks_series_rwt_tkin`);
    add(`https://${host}/dp/${asin}?binding=kindle_edition&ref=dbs_dp_rwt_sb_pc_tkin`);
    add(`https://${host}/gp/product/${asin}`);
    add(`https://${host}/gp/product/${asin}?storeType=ebooks`);
    add(`https://${host}/gp/product/${asin}?binding=kindle_edition&ref_=dbs_s_ks_series_rwt_tkin`);
    add(`https://${host}/kindle-dbs/product/${asin}`);
    add(`https://${host}/-/en/dp/${asin}`);
    add(`https://${host}/-/en/gp/product/${asin}`);
  }

  return urls;
}

function kindleSeriesFetchUrlForAsin(asin) {
  const url = new URL(amazonUrlForAsin(asin));
  url.searchParams.set('binding', 'kindle_edition');
  url.searchParams.set('ref_', 'dbs_s_ks_series_rwt_tkin');
  return url.toString();
}

function isKindleDbsProductUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return /\/kindle-dbs\/product\/[A-Z0-9]{10}/i.test(url.pathname);
  } catch {
    return false;
  }
}

export async function fetchExternalKindleSeriesItems(input, options = {}) {
  const sourceAsin = extractAsin(input);
  if (!sourceAsin) return null;

  const candidates = [
    `https://premium.gamepedia.jp/kindle/series/${sourceAsin}`
  ];

  for (const url of candidates) {
    try {
      const html = await fetchHtml(url, options);
      const items = extractExternalKindleSeriesItemsFromHtml(html, sourceAsin);
      if (items.length > 1) {
        const limit = readPositiveInteger(process.env.SERIES_IMPORT_LIMIT, null);
        const expectedVolumeCount = externalExpectedVolumeCount(html, items);
        return {
          seriesName: extractExternalSeriesName(html),
          sourceAsin,
          expectedVolumeCount,
          completed: extractSeriesCompletionStatus(html),
          items: limit == null ? items : items.slice(0, limit),
          provider: 'external_series'
        };
      }
    } catch {
      // External series pages are a fallback; ignore failures and let callers continue.
    }
  }

  return null;
}

export async function fetchSaleBonKindleSeriesItems(seriesName, options = {}) {
  const normalizedName = cleanTitle(seriesName);
  if (!normalizedName || normalizedName === 'Kindle シリーズ') return null;

  const url = `https://sale-bon.com/detail/?series_hash=${crypto.createHash('md5').update(normalizedName).digest('hex')}`;
  const html = await fetchHtml(url, options);
  const pageSeriesName = extractSaleBonSeriesName(html) || normalizedName;
  if (normalizeSeriesNameForMatch(pageSeriesName) !== normalizeSeriesNameForMatch(normalizedName)) return null;

  const items = extractSaleBonSeriesItemsFromHtml(html, pageSeriesName);
  if (items.length <= 1) return null;

  const limit = readPositiveInteger(process.env.SERIES_IMPORT_LIMIT, null);
  const limitedItems = limit == null ? items : items.slice(0, limit);
  return {
    seriesName: pageSeriesName,
    sourceAsin: options.sourceAsin || '',
    expectedVolumeCount: extractSeriesExpectedCount(html) || maxSeriesItemVolume(limitedItems) || limitedItems.length,
    completed: extractSeriesCompletionStatus(html),
    items: limitedItems,
    provider: 'sale_bon_series'
  };
}

export async function fetchEfoxKindleSeriesItems(seriesName, options = {}) {
  const searchText = cleanTitle(seriesName);
  const normalizedName = cleanTitle(options.seriesName || seriesName);
  if (!searchText || !normalizedName || normalizedName === 'Kindle シリーズ') return null;

  const posts = await fetchEfoxSearchPosts(searchText, options);
  const merged = new Map();

  for (const post of posts) {
    try {
      const detail = await fetchEfoxPost(post, options);
      const items = extractEfoxSeriesItemsFromPost(detail, normalizedName);
      for (const item of items) {
        if (!merged.has(item.asin)) merged.set(item.asin, item);
      }
    } catch {
      // efox is an optional article source; ignore individual post failures.
    }
  }

  const items = [...merged.values()].sort(compareExternalSeriesItems);
  if (items.length <= 1) return null;

  const limit = readPositiveInteger(process.env.SERIES_IMPORT_LIMIT, null);
  const limitedItems = limit == null ? items : items.slice(0, limit);
  return {
    seriesName: normalizedName,
    sourceAsin: options.sourceAsin || '',
    expectedVolumeCount: maxSeriesItemVolume(limitedItems) || limitedItems.length,
    completed: false,
    items: limitedItems,
    provider: 'efox_series'
  };
}

export async function fetchKinpomeKindleSeriesItems(seriesName, options = {}) {
  const searchText = cleanTitle(seriesName);
  const normalizedName = cleanTitle(options.seriesName || seriesName);
  if (!searchText || !normalizedName || normalizedName === 'Kindle シリーズ') return null;

  const html = await fetchKinpomeSearchHtml(searchText, options);
  const items = extractKinpomeSeriesItemsFromHtml(html, normalizedName);
  if (items.length <= 1) return null;

  const limit = readPositiveInteger(process.env.SERIES_IMPORT_LIMIT, null);
  const limitedItems = limit == null ? items : items.slice(0, limit);
  return {
    seriesName: normalizedName,
    sourceAsin: options.sourceAsin || '',
    expectedVolumeCount: maxSeriesItemVolume(limitedItems) || limitedItems.length,
    completed: false,
    items: limitedItems,
    provider: 'kinpome_series'
  };
}

export async function fetchKintyakuKindleSeriesItems(seriesName, options = {}) {
  const searchText = cleanTitle(seriesName);
  const normalizedName = cleanTitle(options.seriesName || seriesName);
  if (!searchText || !normalizedName || normalizedName === 'Kindle シリーズ') return null;

  const records = await fetchKintyakuAmazonSalesItems(searchText, options);
  const items = extractKintyakuSeriesItems(records, normalizedName);
  if (items.length <= 1) return null;

  const limit = readPositiveInteger(process.env.SERIES_IMPORT_LIMIT, null);
  const limitedItems = limit == null ? items : items.slice(0, limit);
  return {
    seriesName: normalizedName,
    sourceAsin: options.sourceAsin || '',
    expectedVolumeCount: maxSeriesItemVolume(limitedItems) || limitedItems.length,
    completed: false,
    items: limitedItems,
    provider: 'kintyaku_series'
  };
}

async function fetchFromKintyaku(asin, seed = {}, options = {}) {
  const normalizedAsin = String(asin || '').toUpperCase();
  if (!isProbablyBookAsin(normalizedAsin)) throw new Error('Kindle版ASINではありません');

  const record = await fetchKintyakuAmazonSalesItem(normalizedAsin, seed, options);
  const item = kintyakuBookItemFromRecord(record);
  if (!item) throw new Error('商品データがありません');

  return normalizeSnapshot({
    ...item,
    asin: normalizedAsin,
    title: bestSnapshotTitle(item.title, seed.title) || `ASIN ${normalizedAsin}`,
    author: item.author || seed.author || '',
    publisher: item.publisher || seed.publisher || '',
    imageUrl: item.imageUrl || seed.imageUrl || '',
    amazonUrl: item.amazonUrl || seed.amazonUrl || amazonUrlForAsin(normalizedAsin),
    provider: 'kintyaku'
  });
}

async function fetchKinpomeSearchHtml(keyword, options = {}) {
  const url = new URL('https://kinpome.com/kindle-sale-search2/');
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('cat', '');
  url.searchParams.set('ex', '');
  url.searchParams.set('hpr', '');
  url.searchParams.set('hpro', '');
  url.searchParams.set('hprr', '');
  url.searchParams.set('hptr', '');
  url.searchParams.set('hrpr', '');
  url.searchParams.set('lpr', '');
  url.searchParams.set('lpro', '');
  url.searchParams.set('lprr', '');
  url.searchParams.set('lptr', '');
  url.searchParams.set('lrpr', '');
  url.searchParams.set('rde', '');
  url.searchParams.set('rds', '');
  url.searchParams.set('st', '');
  return fetchHtml(url.toString(), { signal: options.signal, timeoutMs: options.timeoutMs ?? 6000 });
}

async function fetchEfoxSearchPosts(keyword, options = {}) {
  const postLimit = readPositiveInteger(options.postLimit ?? process.env.EFOX_SEARCH_RESULT_LIMIT, 6);
  const url = new URL('https://www.efox.jp/wp-json/wp/v2/search');
  url.searchParams.set('search', keyword);
  url.searchParams.set('subtype', 'post');
  url.searchParams.set('per_page', String(postLimit));

  const data = await fetchJson(url.toString(), { signal: options.signal, timeoutMs: options.timeoutMs ?? 8000 });
  return (Array.isArray(data) ? data : [])
    .filter((post) => post?.id)
    .slice(0, postLimit);
}

async function fetchEfoxPost(post, options = {}) {
  const id = Number(post?.id);
  if (!Number.isFinite(id) || id <= 0) throw new Error('efox記事IDを取得できませんでした');

  const url = new URL(`https://www.efox.jp/wp-json/wp/v2/posts/${id}`);
  url.searchParams.set('_fields', 'title,link,content,modified,date');
  return fetchJson(url.toString(), { signal: options.signal, timeoutMs: options.timeoutMs ?? 8000 });
}

async function fetchKintyakuAmazonSalesItem(asin, seed = {}, options = {}) {
  let hadQuery = false;

  for (const query of kintyakuBookSearchQueries(asin, seed)) {
    hadQuery = true;
    const records = await fetchKintyakuAmazonSalesItems(query, {
      ...options,
      pageLimit: options.pageLimit ?? process.env.KINTYAKU_BOOK_SEARCH_PAGE_LIMIT ?? 1,
      throwOnError: true
    });
    const record = records.find((item) => String(item?.ASIN || '').toUpperCase() === asin);
    if (record) return record;
  }

  throw new Error(hadQuery ? 'ASIN一致の商品データがありません' : '検索条件がありません');
}

async function fetchKintyakuAmazonSalesItems(keyword, options = {}) {
  const records = [];
  const seen = new Set();
  const pageLimit = readPositiveInteger(options.pageLimit ?? process.env.KINTYAKU_SEARCH_PAGE_LIMIT, 2);
  const categoryNodes = kintyakuCategoryNodes(options);

  for (const categoryNode of categoryNodes) {
    for (let page = 1; page <= pageLimit; page += 1) {
      const url = new URL('https://kintyaku.net/api/amazon-sales');
      url.searchParams.set('keyword', keyword);
      url.searchParams.set('categoryNode', categoryNode);
      url.searchParams.set('ItemPage', String(page));
      url.searchParams.set('sort', 'relevancerank');

      try {
        const data = await fetchJson(url.toString(), {
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? 8000,
          retries: options.retries ?? 1
        });
        for (const item of Array.isArray(data?.Items) ? data.Items : []) {
          const asin = String(item?.ASIN || '').toUpperCase();
          if (!isProbablyBookAsin(asin) || seen.has(asin)) continue;
          seen.add(asin);
          records.push(item);
        }
      } catch (error) {
        if (options.throwOnError) throw error;
        break;
      }
    }
  }

  return records;
}

function kintyakuBookSearchQueries(asin, seed = {}) {
  const normalizedAsin = String(asin || '').toUpperCase();
  const queries = [];
  const add = (value) => {
    const query = kintyakuBookSearchQuery(value, normalizedAsin);
    if (query && !queries.includes(query)) queries.push(query);
  };

  add(seed.title);
  add(titleFromSnapshotSeed(seed));
  add(seed.seriesName);
  add(normalizedAsin);

  return queries.slice(0, 4);
}

function kintyakuBookSearchQuery(value, asin) {
  const raw = cleanTitle(value);
  if (!raw) return '';
  if (raw.toUpperCase() === asin) return asin;

  return raw
    .replace(/^ASIN\s+[A-Z0-9]{10}(?:\s*[（(].*?[）)])?$/i, '')
    .replace(/\s*[（(](?:取得待ち|要確認|Kindle版ではありません)[）)]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function kintyakuCategoryNodes(options = {}) {
  const configured = String(options.categoryNodes || process.env.KINTYAKU_CATEGORY_NODES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length) return [...new Set(configured)];

  return [
    '2278488051',
    '2293143051',
    '2410280051'
  ];
}

function extractKinpomeSeriesItemsFromHtml(html, seriesName) {
  const items = [];
  const seen = new Set();

  for (const match of String(html || '').matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const item = kinpomeSeriesItemFromRow(match[0], seriesName);
    if (!item || seen.has(item.asin)) continue;
    items.push(item);
    seen.add(item.asin);
  }

  return items.sort(compareExternalSeriesItems);
}

function kinpomeSeriesItemFromRow(row, seriesName) {
  const item = kinpomeBookItemFromRow(row);
  if (!item) return null;

  const volume = extractExternalVolumeFromTitle(item.title);
  if (!volume) return null;
  if (normalizeSeriesNameForMatch(externalSeriesBaseName(item.title)) !== normalizeSeriesNameForMatch(seriesName)) return null;

  return {
    ...item,
    volume,
    provider: 'kinpome_series'
  };
}

function kinpomeBookItemFromRow(row) {
  const link = String(row || '').match(/<a\b[^>]*href=["']([^"']*amazon\.co\.jp[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
  if (!link) return null;

  const href = decodeHtml(link[1]);
  const asin = extractAsin(href);
  if (!asin || !isProbablyBookAsin(asin)) return null;

  const title = cleanTitle(link[2]);
  const rightValues = [...String(row || '').matchAll(/<td\b[^>]*class=["'][^"']*right[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi)]
    .map((cell) => cleanText(cell[1]))
    .filter(Boolean);
  const currentPrice = parsePrice(toHalfWidthNumber(rightValues[0] || ''));
  if (currentPrice == null) return null;

  return {
    asin,
    title,
    imageUrl: '',
    imageSource: '',
    amazonUrl: amazonUrlForAsin(asin),
    currentPrice,
    currentPoints: 0,
    effectivePrice: currentPrice,
    listPrice: null,
    provider: 'kinpome'
  };
}

function extractEfoxSeriesItemsFromPost(post, seriesName) {
  const html = String(post?.content?.rendered || '');
  const items = [];
  const seen = new Set();

  for (const block of efoxProductBlocks(html)) {
    const item = efoxBookItemFromBlock(block);
    if (!item || seen.has(item.asin)) continue;

    const volume = extractExternalVolumeFromTitle(item.title);
    if (!volume) continue;
    if (normalizeSeriesNameForMatch(externalSeriesBaseName(item.title)) !== normalizeSeriesNameForMatch(seriesName)) continue;

    items.push({
      ...item,
      volume,
      provider: item.currentPrice == null ? 'efox_series' : 'efox'
    });
    seen.add(item.asin);
  }

  return items.sort(compareExternalSeriesItems);
}

function efoxProductBlocks(html) {
  const value = String(html || '');
  const starts = [...value.matchAll(/<div\b[^>]*class=["'][^"']*(?:amazon-item-box|product-item-box)[^"']*\b(B[A-Z0-9]{9})\b[^"']*["'][^>]*>/gi)];
  return starts.map((match, index) => {
    const end = starts[index + 1]?.index ?? value.length;
    return {
      asin: match[1].toUpperCase(),
      html: value.slice(match.index, end)
    };
  });
}

function efoxBookItemFromBlock(block) {
  const asin = String(block?.asin || '').toUpperCase();
  const fragment = String(block?.html || '');
  if (!isProbablyBookAsin(asin)) return null;

  const title = extractExternalTitleCandidate(fragment) || extractAnchorText(fragment, asin);
  if (!title) return null;

  const currentPrice = extractEfoxCurrentPrice(fragment);
  const currentPoints = extractExternalPoints(fragment);
  const imageUrl = extractItemImage(fragment);
  return {
    asin,
    title,
    author: '',
    publisher: cleanMetadataText(fragment.match(/<div\b[^>]*class=["'][^"']*(?:amazon-item-maker|product-item-maker)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || ''),
    imageUrl,
    imageSource: imageUrl ? 'efox' : '',
    amazonUrl: amazonUrlForAsin(asin),
    currentPrice,
    currentPoints,
    effectivePrice: currentPrice == null ? null : Math.max(0, Math.round(currentPrice - currentPoints)),
    listPrice: null,
    provider: 'efox'
  };
}

function extractEfoxCurrentPrice(fragment) {
  const explicit = String(fragment || '').match(/<span\b[^>]*class=["'][^"']*item-price[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  const currentPrice = parsePrice(toHalfWidthNumber(explicit?.[1] || ''));
  if (currentPrice != null) return currentPrice;
  return extractExternalCurrentPrice(fragment);
}

function extractKintyakuSeriesItems(records, seriesName) {
  const items = [];
  const seen = new Set();

  for (const record of records) {
    const item = kintyakuBookItemFromRecord(record);
    if (!item || seen.has(item.asin)) continue;

    const volume = extractExternalVolumeFromTitle(item.title);
    if (!volume) continue;
    if (normalizeSeriesNameForMatch(externalSeriesBaseName(item.title)) !== normalizeSeriesNameForMatch(seriesName)) continue;

    items.push({
      ...item,
      volume,
      provider: item.currentPrice == null ? 'kintyaku_series' : 'kintyaku'
    });
    seen.add(item.asin);
  }

  return items.sort(compareExternalSeriesItems);
}

function kintyakuBookItemFromRecord(record) {
  const asin = String(record?.ASIN || '').toUpperCase();
  if (!isProbablyBookAsin(asin)) return null;

  const listing = Array.isArray(record?.Offers?.Listings) ? record.Offers.Listings[0] : null;
  const price = listing?.Price || {};
  const currentPrice = parsePrice(price.Amount ?? price.DisplayAmount);
  const currentPoints = parsePoints(listing?.LoyaltyPoints?.Points);
  const title = cleanTitle(record?.ItemInfo?.Title?.DisplayValue || '');
  if (!title) return null;

  return {
    asin,
    title,
    author: kintyakuContributorsText(record),
    publisher: cleanMetadataText(record?.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue || ''),
    imageUrl: record?.Images?.Primary?.Medium?.URL || record?.Images?.Primary?.Large?.URL || '',
    imageSource: record?.Images?.Primary ? 'kintyaku' : '',
    amazonUrl: amazonUrlForAsin(asin),
    currentPrice,
    currentPoints,
    effectivePrice: currentPrice == null ? null : Math.max(0, Math.round(currentPrice - currentPoints)),
    listPrice: null,
    provider: 'kintyaku'
  };
}

function kintyakuContributorsText(record) {
  const contributors = Array.isArray(record?.ItemInfo?.ByLineInfo?.Contributors)
    ? record.ItemInfo.ByLineInfo.Contributors
    : [];
  return contributors
    .map((item) => cleanContributorText(item?.Name || ''))
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
}

function externalSeriesBaseName(title) {
  return cleanTitle(title)
    .replace(/\s*[（(][^（）()]{0,80}(?:コミックス|コミック|文庫|新書|DX|KC|REX|ZERO-SUM|モーニング|イブニング|アフタヌーン|ビッグ|スピリッツ|ジャンプ|マガジン|サンデー|チャンピオン|ヒーローズ|ebook|Kindle)[^（）()]{0,80}[）)]\s*$/i, '')
    .replace(/\s*[（(]\s*(?:第\s*)?[0-9０-９]{1,3}\s*(?:巻)?\s*[）)]\s*$/i, '')
    .replace(/\s*(?:第\s*)?[0-9０-９]{1,3}\s*巻\s*$/i, '')
    .replace(/[　\s]+[0-9０-９]{1,3}[　\s]+.+$/i, '')
    .replace(/\s+[0-9０-９]{1,3}\s*$/i, '')
    .trim();
}

export function extractKindleSeriesItemsFromHtml(html) {
  const ordered = new Map();
  const value = String(html || '');
  const seriesName = extractSeriesName(value);
  const seriesImageUrl = extractMeta(value, 'og:image');
  const childItems = extractChildAsinListItems(value);

  const bulkOfferItems = extractLargestBulkOfferItems(value, { seriesName, seriesImageUrl });
  if (shouldUseBulkOfferItemsForSeries(bulkOfferItems, childItems, value)) {
    const childByAsin = new Map(childItems.map((item) => [item.asin, item]));
    const mergeOptions = {
      preferChildTitle: shouldPreferChildSeriesTitles(bulkOfferItems, childItems)
    };
    return bulkOfferItems.map((item) => mergeBulkSeriesItem(item, childByAsin.get(item.asin), mergeOptions));
  }

  if (childItems.length > 1) {
    return childItems;
  }

  for (const match of value.matchAll(/<a\b[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
    const href = decodeHtml(match[1]);
    const asin = extractAsin(href);
    if (!asin) continue;

    if (isSeriesTitleHref(href)) {
      const fragment = extractItemFragment(value, match.index);
      ordered.set(asin, mergeSeriesItem(ordered.get(asin), itemFromFragment(asin, fragment)));
    }
  }

  const seriesSections = extractLikelySeriesSections(value);
  for (const section of seriesSections) {
    for (const match of section.matchAll(/["'](?:asin|ASIN|productAsin|childAsin)["']\s*:\s*["']([A-Z0-9]{10})["']/g)) {
      const asin = match[1].toUpperCase();
      const fragment = extractItemFragment(section, match.index);
      ordered.set(asin, mergeSeriesItem(ordered.get(asin), itemFromFragment(asin, fragment)));
    }

    for (const match of section.matchAll(/["'](?:childAsins|seriesAsins|kindleAsins)["']\s*:\s*\[([\s\S]*?)\]/g)) {
      for (const asin of match[1].match(ASIN_GLOBAL_PATTERN) || []) {
        const normalized = asin.toUpperCase();
        const fragment = extractItemFragment(section, section.indexOf(asin, match.index));
        ordered.set(normalized, mergeSeriesItem(ordered.get(normalized), itemFromFragment(normalized, fragment)));
      }
    }

    for (const match of section.matchAll(/\bdata-asin=["']([A-Z0-9]{10})["']/gi)) {
      const asin = match[1].toUpperCase();
      const fragment = extractItemFragment(section, match.index);
      ordered.set(asin, mergeSeriesItem(ordered.get(asin), itemFromFragment(asin, fragment)));
    }
  }

  return [...ordered.values()].filter((item) => isProbablyBookAsin(item.asin));
}

function shouldUseBulkOfferItemsForSeries(bulkItems = [], childItems = [], html = '') {
  if (bulkItems.length <= childItems.length) return false;
  if (bulkItemsLikelyDifferentEdition(bulkItems, childItems)) return false;
  if (childItems.length === 0 && !hasStandaloneBulkSeriesEvidence(html, bulkItems)) return false;
  return true;
}

function hasStandaloneBulkSeriesEvidence(html, bulkItems = []) {
  const value = String(html || '');
  if (!bulkItems.length) return false;
  const expected = extractSeriesExpectedCount(value);
  if (expected > 1 && bulkItems.length < expected) return false;
  if (/id=["']series-childAsin-list["']|id=["']series-childAsin-item_\d+["']/i.test(value)) return true;
  if (/hulk-buy-card|Kindle版\(電子書籍\)のシリーズを購入|まとめ買い\s*[（(]\s*巻\s*[）)]|シリーズの巻/i.test(value)) return true;

  if (expected <= 1) return false;
  return bulkItems.length >= expected;
}

function bulkItemsLikelyDifferentEdition(bulkItems = [], childItems = []) {
  if (childItems.length < 2) return false;

  const bulkAsins = new Set(bulkItems.map((item) => item?.asin).filter(Boolean));
  const childAsins = childItems.map((item) => item?.asin).filter(Boolean);
  if (childAsins.length < 2) return false;

  const overlap = childAsins.filter((asin) => bulkAsins.has(asin)).length;
  return overlap < childAsins.length;
}

function extractExternalKindleSeriesItemsFromHtml(html, sourceAsin = '') {
  const block = extractExternalMainSeriesBlock(html);
  const seriesName = extractExternalSeriesName(html);
  const seriesImageUrl = extractExternalSeriesImage(html);
  const value = String(block || '');

  const context = { seriesName, seriesImageUrl };
  const cardItems = extractExternalSeriesCardItems(value, context);
  const items = cardItems.length > 0 ? cardItems : extractExternalSeriesLinkItems(value, context);

  return items.sort(compareExternalSeriesItems);
}

function externalExpectedVolumeCount(html, items) {
  return extractSeriesExpectedCount(html) || maxSeriesItemVolume(items) || items.length;
}

function extractExternalAmazonLinks(html) {
  const links = [];
  const value = String(html || '');

  for (const match of value.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1] || '';
    const href = extractAttribute(`<a ${attrs}>`, 'href');
    if (!href) continue;

    const decodedHref = decodeURIComponentSafe(href);
    if (!/amazon\.(?:co\.jp|com)/i.test(`${href} ${decodedHref}`)) continue;

    const asin = extractAsin(href) || extractAsin(decodedHref);
    if (!asin) continue;

    links.push({
      index: match.index,
      asin,
      text: match[2],
      href,
      attrs,
      fragment: match[0]
    });
  }

  return links;
}

function extractExternalSeriesCardItems(html, options) {
  const links = extractExternalAmazonLinks(html).filter((link) =>
    /\bseries-item-card\b/i.test(decodeHtml(`${link.attrs} ${link.fragment}`))
  );
  return collectExternalSeriesItems(links, options, (link) => link.fragment);
}

function extractExternalSeriesLinkItems(html, options) {
  const links = extractExternalAmazonLinks(html);
  return collectExternalSeriesItems(links, options, (link, index) => {
    const nextIndex = links[index + 1]?.index ?? link.index + 1800;
    return html.slice(Math.max(0, link.index - 400), Math.min(html.length, nextIndex));
  });
}

function collectExternalSeriesItems(links, options, fragmentForLink) {
  const items = [];
  const seen = new Set();

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const asin = link.asin;
    if (!isProbablyBookAsin(asin) || seen.has(asin)) continue;

    const item = externalSeriesItemFromFragment(
      asin,
      fragmentForLink(link, index),
      options,
      cleanText(link.text)
    );
    if (!item) continue;

    items.push(item);
    seen.add(asin);
  }

  return items;
}

function externalSeriesItemFromFragment(asin, fragment, options, linkText = '') {
  const titleCandidate = extractExternalTitleCandidate(fragment);
  const text = cleanText(`${linkText} ${fragment}`);
  const volume =
    extractExternalVolumeFromTitle(titleCandidate) ||
    extractExternalVolumeFromTitle(linkText) ||
    extractExternalVolume(text);
  if (!volume) return null;

  const currentPrice = extractExternalCurrentPrice(text);
  const currentPoints = currentPrice === 0 ? 0 : extractExternalPoints(text);
  const listPrice = extractExternalListPrice(text, currentPrice);
  const itemImageUrl = extractItemImage(fragment);

  return {
    asin,
    title: cleanExternalItemTitle(titleCandidate || linkText, options.seriesName, volume),
    imageUrl: itemImageUrl || options.seriesImageUrl,
    imageSource: itemImageUrl ? 'external_series' : 'series_fallback',
    amazonUrl: amazonUrlForAsin(asin),
    volume,
    currentPrice,
    currentPoints,
    effectivePrice: currentPrice == null ? null : Math.max(0, Math.round(currentPrice - currentPoints)),
    listPrice,
    provider: 'external_series'
  };
}

function extractExternalMainSeriesBlock(html) {
  const value = String(html || '');
  const headingIndex = value.search(/<h1\b/i);
  const start = headingIndex === -1 ? 0 : headingIndex;
  const markers = [
    'おすすめセール',
    '関連記事',
    '<footer',
    '<aside',
    '#### メインメニュー',
    '## ランキング',
    '## 新着記事'
  ];
  let end = value.length;

  for (const marker of markers) {
    const index = value.indexOf(marker, start + 1);
    if (index !== -1 && index < end) end = index;
  }

  return value.slice(start, end);
}

function extractExternalSeriesName(html) {
  return cleanTitle(
    extractTag(html, 'h1') ||
      extractMeta(html, 'og:title') ||
      extractTag(html, 'title')
  )
    .replace(/\s*のKindleセール一覧.*$/, '')
    .replace(/\s*\|\s*セール履歴・詳細.*$/, '')
    .replace(/\s*セール履歴・詳細.*$/, '')
    .replace(/\s*全\s*[0-9０-９]+\s*巻.*$/, '')
    .trim();
}

function extractSaleBonSeriesName(html) {
  return cleanTitle(
    extractTag(html, 'h1') ||
      extractMeta(html, 'og:title') ||
      extractTag(html, 'title')
  )
    .replace(/\s*\|\s*セール履歴・詳細.*$/, '')
    .replace(/\s*セール履歴・詳細.*$/, '')
    .trim();
}

function extractSaleBonSeriesItemsFromHtml(html, seriesName) {
  const block = extractSaleBonSeriesBlock(html);
  const seriesImageUrl = extractMeta(html, 'og:image') || extractItemImage(html);
  const items = [];
  const seen = new Set();

  for (const match of String(block || '').matchAll(/<dt\b[\s\S]*?<\/dt>\s*<dd\b[\s\S]*?<\/dd>/gi)) {
    const fragment = match[0];
    const asin = extractAsin(fragment);
    if (!asin || !isProbablyBookAsin(asin) || seen.has(asin)) continue;

    const title =
      cleanTitle(fragment.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '') ||
      `${seriesName || 'Kindle シリーズ'} ${items.length + 1}`;
    const volume = extractExternalVolumeFromTitle(title) || extractExternalVolume(title);
    if (!volume) continue;

    const priceText = cleanText(fragment);
    const prices = extractExternalYenValues(priceText);
    const currentPrice = prices.length ? prices[prices.length - 1] : null;
    const currentPoints = currentPrice === 0 ? 0 : extractExternalPoints(priceText);

    const itemImageUrl = extractItemImage(fragment);
    items.push({
      asin,
      title: cleanExternalItemTitle(title, seriesName, volume),
      imageUrl: itemImageUrl || seriesImageUrl,
      imageSource: itemImageUrl ? 'sale_bon_series' : 'series_fallback',
      amazonUrl: amazonUrlForAsin(asin),
      volume,
      currentPrice,
      currentPoints,
      effectivePrice: currentPrice == null ? null : Math.max(0, Math.round(currentPrice - currentPoints)),
      listPrice: prices.length > 1 ? prices[0] : null,
      provider: 'sale_bon_series'
    });
    seen.add(asin);
  }

  return items.sort(compareExternalSeriesItems);
}

function extractSaleBonSeriesBlock(html) {
  const value = String(html || '');
  const start = value.indexOf('id="series-comic-list"');
  if (start === -1) return '';

  const endMarkers = [
    '<h2 id="sale-history-title"',
    '<h2 id="series-info-title"',
    '<section',
    '<footer'
  ];
  let end = value.length;
  for (const marker of endMarkers) {
    const index = value.indexOf(marker, start + 1);
    if (index !== -1 && index < end) end = index;
  }
  return value.slice(start, end);
}

function normalizeSeriesNameForMatch(value) {
  return cleanTitle(value).replace(/\s+/g, '').toLowerCase();
}

function extractExternalSeriesImage(html) {
  const image = extractMeta(html, 'og:image') || extractItemImage(html);
  return image || '';
}

function extractExternalVolume(text) {
  const match = String(text || '').match(/(?:第)?([0-9０-９]{1,3})\s*巻/);
  if (!match) return '';
  return String(toHalfWidthNumber(match[1]));
}

function extractExternalVolumeFromTitle(text) {
  const value = cleanTitle(text);
  if (!value) return '';

  const explicit = value.match(/(?:第)?([0-9０-９]{1,3})\s*巻(?:\s|$|[（(])/);
  if (explicit) return String(toHalfWidthNumber(explicit[1]));

  const parenthesized = value.match(/[（(]\s*([0-9０-９]{1,3})\s*[）)](?:\s*[（(][^（）()]{0,80}[）)])?\s*$/);
  if (parenthesized) return String(toHalfWidthNumber(parenthesized[1]));

  const isolated = value.match(/[　\s]([0-9０-９]{1,3})(?=[　\s]|$)/);
  if (isolated) return String(toHalfWidthNumber(isolated[1]));

  const terminal = value.match(/(?:^|[^0-9０-９])([0-9０-９]{1,3})\s*$/);
  return terminal ? String(toHalfWidthNumber(terminal[1])) : '';
}

function extractExternalTitleCandidate(fragment) {
  const candidates = [
    ...extractAttributes(fragment, 'alt'),
    ...extractAttributes(fragment, 'title'),
    ...extractAttributes(fragment, 'aria-label')
  ]
    .map(cleanTitle)
    .filter(Boolean)
    .filter((title) => !/^https?:\/\//i.test(title))
    .filter((title) => !/Amazon\.co\.jp/i.test(title));

  return (
    candidates.find((title) => !isExternalVolumeOnlyTitle(title) && !isExternalPriceOnlyText(title)) ||
    candidates[0] ||
    ''
  );
}

function cleanExternalItemTitle(text, seriesName, volume) {
  const volumeLabel = `${volume}巻`;
  const cleaned = cleanTitle(text)
    .replace(/\s*(?:セール中|Kindle Unlimited|Unlimited).*$/i, '')
    .replace(/\s*(?:￥|¥|価格:).*$/, '')
    .trim();

  if (cleaned && !isExternalVolumeOnlyTitle(cleaned)) {
    return extractExternalVolumeFromTitle(cleaned) ? cleaned : `${cleaned} ${volumeLabel}`;
  }
  return `${seriesName || 'Kindle シリーズ'} ${volumeLabel}`;
}

function extractExternalCurrentPrice(text) {
  const value = String(text || '');

  const explicit = value.match(/価格\s*:\s*([0-9０-９][0-9０-９,，]*)\s*円/);
  if (explicit) return parsePrice(toHalfWidthNumber(explicit[1]));

  const yenValues = extractExternalYenValues(value);
  if (yenValues.length === 0) return isExplicitExternalFreePrice(value) ? 0 : null;
  if (yenValues.length === 1) return yenValues[0];
  return yenValues[yenValues.length - 1];
}

function isExplicitExternalFreePrice(text) {
  const value = cleanText(text).replace(/\s+/g, '');
  return /(?:価格|現在価格|販売価格|Kindle価格)[:：]?無料/.test(value) || /無料で購入/.test(value);
}

function extractExternalListPrice(text, currentPrice) {
  const prices = extractExternalYenValues(text);
  if (currentPrice === 0 && prices.length > 0) return prices[0];
  if (prices.length < 2) return null;
  return prices.find((price) => currentPrice == null || price >= currentPrice) ?? null;
}

function isExternalVolumeOnlyTitle(text) {
  return /^第?\s*[0-9０-９]+\s*巻(?:\s|$)/.test(String(text || ''));
}

function isExternalPriceOnlyText(text) {
  const value = cleanText(text).replace(/\s+/g, '');
  if (!value) return true;
  return /^(?:価格[:：]?)?(?:無料|(?:￥|¥)?[0-9０-９,，]+円?)(?:[（(]?[0-9０-９,，]+(?:pt|ポイント)[）)]?)?$/i.test(value);
}

function compareExternalSeriesItems(a, b) {
  const left = Number(a.volume);
  const right = Number(b.volume);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  return String(a.title || a.asin).localeCompare(String(b.title || b.asin), 'ja');
}

function extractExternalPoints(text) {
  const value = String(text || '');
  const explicit =
    value.match(/ポイント\s*:\s*([0-9０-９][0-9０-９,，]*)\s*pt/i) ||
    value.match(/[（(]\s*([0-9０-９][0-9０-９,，]*)\s*ポイント/);
  return explicit ? parsePoints(toHalfWidthNumber(explicit[1])) : 0;
}

function extractExternalYenValues(text) {
  const decoded = decodeHtml(String(text || ''));
  const values = [];
  const patterns = [
    /(?:￥|¥)\s*([0-9０-９][0-9０-９,，]*)/g,
    /([0-9０-９][0-9０-９,，]*)\s*円/g
  ];

  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      const price = parsePrice(toHalfWidthNumber(match[1]));
      if (price != null) values.push(price);
    }
  }

  return dedupeNumbers(values);
}

function dedupeNumbers(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export async function fetchBookSnapshot(asin, options = {}) {
  const provider = (process.env.PRICE_PROVIDER || 'amazon_html').toLowerCase();
  const errors = [];
  const normalizedAsin = String(asin || '').toUpperCase();
  const inputUrl = typeof options === 'string' ? options : options.url || '';
  const context = typeof options === 'string' ? { url: inputUrl } : options || {};

  if (!isProbablyBookAsin(normalizedAsin)) {
    throw new Error('Kindle版ASINではありません。Kindle商品ページのBで始まるASINを登録してください');
  }

  if ((provider === 'auto' || provider === 'keepa') && process.env.KEEPA_API_KEY) {
    try {
      return await fetchFromKeepa(normalizedAsin);
    } catch (error) {
      errors.push(`Keepa: ${error.message}`);
      if (provider === 'keepa') throw error;
    }
  }

  if (provider === 'listasin') {
    return fetchFromListasin(normalizedAsin, context);
  }

  if (provider === 'auto' || provider === 'amazon_html') {
    try {
      return await fetchFromAmazonHtml(normalizedAsin, inputUrl, context);
    } catch (error) {
      errors.push(`Amazon HTML: ${error.message}`);
      if (provider === 'amazon_html') throw error;
    }
  }

  throw new Error(errors.join(' / ') || '価格取得プロバイダが設定されていません');
}

export async function fetchAmazonHtmlSnapshot(asin, url = '', options = {}) {
  return fetchFromAmazonHtml(asin, url, { ...options, url });
}

async function fetchFromKeepa(asin) {
  const domain = keepaDomainId(process.env.AMAZON_DOMAIN || 'JP');
  const url = new URL('https://api.keepa.com/product');
  url.searchParams.set('key', process.env.KEEPA_API_KEY);
  url.searchParams.set('domain', String(domain));
  url.searchParams.set('asin', asin);
  url.searchParams.set('stats', '1');
  url.searchParams.set('history', '0');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || data.error.type || 'Keepa API error');
  }

  const product = data.products?.[0];
  if (!product) throw new Error('商品が見つかりません');

  const current = product.stats?.current || [];
  const price = keepaPrice(current[0]) ?? keepaPrice(current[1]) ?? keepaPrice(current[18]);
  const listPrice = keepaPrice(current[4]) ?? keepaPrice(product.listPrice);
  const imageName = product.imagesCSV?.split(',')?.[0];
  const imageUrl = imageName ? `https://m.media-amazon.com/images/I/${imageName}` : null;

  return normalizeSnapshot({
    asin: product.asin || asin,
    title: product.title,
    author: Array.isArray(product.author) ? product.author.join(', ') : product.author,
    publisher: product.manufacturer || product.publisher,
    imageUrl,
    currentPrice: price,
    listPrice,
    currentPoints: 0,
    amazonUrl: amazonUrlForAsin(asin),
    provider: 'keepa'
  });
}

async function fetchFromAmazonHtml(asin, inputUrl = '', options = {}) {
  let lastSnapshot = null;
  const errors = [];
  let amazonBlocked = false;
  let listasinTried = false;
  let nonKindleProductDetected = false;
  const allowExternalPriceFallback = options.allowExternalPriceFallback !== false;

  for (const url of amazonProductCandidateUrls(asin, inputUrl, options)) {
    try {
      const html = await fetchAmazonHtml(url, options);
      const snapshot = isAmazonSearchUrl(url)
        ? extractAmazonSearchSnapshotFromHtml(html, asin, url, 'amazon_html', options)
        : extractAmazonHtmlSnapshotFromHtml(html, asin, url, 'amazon_html', options);
      if (snapshot.currentPrice != null) return snapshot;
      lastSnapshot = snapshot;
    } catch (error) {
      if (isPermanentKindleProductError(error)) {
        nonKindleProductDetected = true;
        errors.push(`${amazonFetchUrlLabel(url)}: ${error.message}`);
        continue;
      }
      errors.push(`${amazonFetchUrlLabel(url)}: ${error.message}`);
      if (isAmazonBlockingFetchError(error)) {
        if (shouldContinueAfterBlockedKindleDbsUrl(url)) continue;
        amazonBlocked = true;
        break;
      }
    }
  }

  if (allowExternalPriceFallback && shouldUseEarlyListasinFallback(options)) {
    listasinTried = true;
    try {
      const snapshot = await fetchFromListasin(asin, snapshotSeedFromOptions(asin, options, lastSnapshot), options);
      return lastSnapshot ? mergeSnapshotLike(lastSnapshot, snapshot) : snapshot;
    } catch (error) {
      errors.push(`listasIn: ${error.message}`);
    }
  }

  if (!amazonBlocked && options.allowAmazonReaderFallback !== false && shouldUseAmazonReaderFallback()) {
    try {
      const snapshot = await fetchFromAmazonReader(asin, inputUrl, options);
      if (snapshot.currentPrice != null && !shouldDeferAmazonReaderPrice(snapshot, options)) {
        return lastSnapshot ? mergeSnapshotLike(lastSnapshot, snapshot) : snapshot;
      }
      const metadataSnapshot = shouldDeferAmazonReaderPrice(snapshot, options) ? snapshotWithoutPrice(snapshot) : snapshot;
      lastSnapshot = lastSnapshot ? mergeSnapshotLike(lastSnapshot, metadataSnapshot) : metadataSnapshot;
    } catch (error) {
      if (isPermanentKindleProductError(error)) nonKindleProductDetected = true;
      errors.push(`reader: ${error.message}`);
    }
  }

  if (allowExternalPriceFallback) {
    try {
      const snapshot = await fetchFromKintyaku(asin, snapshotSeedFromOptions(asin, options, lastSnapshot), options);
      if (snapshot.currentPrice != null) return lastSnapshot ? mergeSnapshotLike(lastSnapshot, snapshot) : snapshot;
      lastSnapshot = lastSnapshot ? mergeSnapshotLike(lastSnapshot, snapshot) : snapshot;
    } catch (error) {
      errors.push(`Kintyaku: ${error.message}`);
    }

    if (!listasinTried) {
      try {
        const snapshot = await fetchFromListasin(asin, snapshotSeedFromOptions(asin, options, lastSnapshot), options);
        return lastSnapshot ? mergeSnapshotLike(lastSnapshot, snapshot) : snapshot;
      } catch (error) {
        errors.push(`listasIn: ${error.message}`);
      }
    }
  }

  if (!lastSnapshot && (nonKindleProductDetected || isLegacyPhysicalProductAsin(asin))) {
    throw nonKindleProductError();
  }

  if (lastSnapshot) return lastSnapshot;
  throw new Error(compactFetchErrors(errors) || 'Amazon HTMLで商品情報を取得できませんでした');
}

async function fetchFromListasin(asin, seed = {}, options = {}) {
  const normalizedAsin = String(asin || '').toUpperCase();
  if (!isProbablyBookAsin(normalizedAsin)) throw new Error('Kindle版ASINではありません');

  const url = new URL('https://www.listasin.net/api/0200_jd.cgi');
  url.searchParams.set('asins', normalizedAsin);
  const data = await fetchJson(url.toString(), {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 5000,
    retries: 2,
    retryDelayMs: 300
  });
  const record = data?.result?.books?.[normalizedAsin];
  if (!record) throw new Error('価格データがありません');

  const currentPrice = parsePrice(record.latest_price);
  if (currentPrice == null) throw new Error('価格データがありません');

  const title = cleanTitle(seed.title || '') || titleFromSnapshotSeed(seed) || `ASIN ${normalizedAsin}`;
  return normalizeSnapshot({
    asin: normalizedAsin,
    title,
    author: seed.author || '',
    publisher: seed.publisher || '',
    imageUrl: seed.imageUrl || '',
    amazonUrl: seed.amazonUrl || amazonUrlForAsin(normalizedAsin),
    currentPrice,
    currentPoints: parsePoints(record.latest_point),
    listPrice: parsePrice(record.max_price),
    provider: 'listasin'
  });
}

function snapshotSeedFromOptions(asin, options = {}, lastSnapshot = null) {
  const normalizedAsin = String(asin || '').toUpperCase();
  const optionSourceUrl = String(options.sourceUrl || '');
  const optionAmazonUrl =
    options.amazonUrl ||
    (extractAsin(optionSourceUrl) === normalizedAsin ? optionSourceUrl : '') ||
    amazonUrlForAsin(normalizedAsin);
  return {
    asin: normalizedAsin,
    title: bestSnapshotTitle(lastSnapshot?.title, options.title),
    author: lastSnapshot?.author || options.author || '',
    publisher: lastSnapshot?.publisher || options.publisher || '',
    imageUrl: lastSnapshot?.imageUrl || options.imageUrl || '',
    amazonUrl: lastSnapshot?.amazonUrl || optionAmazonUrl,
    seriesName: options.seriesName || '',
    volume: options.volume || ''
  };
}

function titleFromSnapshotSeed(seed = {}) {
  if (seed.seriesName && seed.volume) return `${seed.seriesName} ${seed.volume}`;
  return '';
}

function amazonProductCandidateUrls(asin, inputUrl = '', options = {}) {
  const normalizedAsin = String(asin || '').toUpperCase();
  const urls = [];
  const add = (value, options = {}) => {
    if (!value || urls.includes(value)) return;
    if (!options.skipAsinCheck && extractAsin(value) !== normalizedAsin) return;
    urls.push(value);
  };

  const base = amazonUrlForAsin(normalizedAsin);
  add(base);
  add(withAmazonSearchParams(base, { binding: 'kindle_edition', ref: 'dbs_dp_rwt_sb_pc_tkin' }));

  try {
    add(normalizeAmazonUrl(inputUrl));
  } catch {
    // Ignore non-Amazon/empty input; canonical candidates remain.
  }
  add(inputUrl);
  add(withAmazonSearchParams(inputUrl, { binding: 'kindle_edition', ref: 'dbs_dp_rwt_sb_pc_tkin' }));

  if (options.allowAmazonExtendedFallback === false) return urls;

  try {
    const baseUrl = new URL(base);
    const host = baseUrl.host;
    add(`https://${host}/kindle-dbs/product/${normalizedAsin}`);
    add(`https://${host}/-/en/dp/${normalizedAsin}`);
    add(`https://${host}/gp/product/${normalizedAsin}`);
    add(`https://${host}/-/en/gp/product/${normalizedAsin}`);
    add(`https://${host}/gp/product/${normalizedAsin}?storeType=ebooks`);
    add(`https://${host}/gp/product/${normalizedAsin}?binding=kindle_edition&ref=dbs_dp_rwt_sb_pc_tkin`);
    add(`https://${host}/gp/aw/d/${normalizedAsin}`);
    add(`https://${host}/gp/aw/d/${normalizedAsin}?storeType=ebooks`);
    add(`https://${host}/gp/aw/d/${normalizedAsin}?binding=kindle_edition`);
    if (options.allowAmazonSearchFallback !== false) {
      for (const query of amazonSearchQueriesForInput(inputUrl, normalizedAsin)) {
        add(`https://${host}/s?k=${encodeURIComponent(query)}&i=digital-text`, { skipAsinCheck: true });
      }
      add(`https://${host}/s?k=${normalizedAsin}&i=digital-text`, { skipAsinCheck: true });
    }
  } catch {
    // Keep the canonical URL candidates.
  }

  return urls;
}

function amazonSearchQueriesForInput(inputUrl, asin) {
  const queries = [];
  const add = (value) => {
    const query = normalizeAmazonSearchQuery(value, asin);
    if (query && !queries.includes(query)) queries.push(query);
  };

  try {
    const url = new URL(String(inputUrl || ''));
    add(url.searchParams.get('keywords'));
    add(url.searchParams.get('k'));
    add(amazonTitleSlugFromPath(url.pathname, asin));
  } catch {
    // No URL-derived search queries.
  }

  return queries.slice(0, 4);
}

function amazonTitleSlugFromPath(pathname, asin) {
  let decoded = '';
  try {
    decoded = decodeURIComponent(String(pathname || ''));
  } catch {
    decoded = String(pathname || '');
  }

  const parts = decoded.split('/').filter(Boolean);
  const dpIndex = parts.findIndex((part, index) => /^dp$/i.test(part) && String(parts[index + 1] || '').toUpperCase() === asin);
  const gpIndex = parts.findIndex(
    (part, index) => /^gp$/i.test(part) && /^product$/i.test(parts[index + 1] || '') && String(parts[index + 2] || '').toUpperCase() === asin
  );
  const markerIndex = dpIndex >= 0 ? dpIndex : gpIndex;
  return markerIndex > 0 ? parts[markerIndex - 1] : '';
}

function normalizeAmazonSearchQuery(value, asin) {
  const text = cleanTitle(value)
    .replace(new RegExp(escapeRegExp(asin), 'ig'), '')
    .replace(/\b(?:ebook|kindle|edition|amazon|co|jp)\b/gi, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length < 2) return '';
  if (/^[A-Z0-9]{10}$/i.test(text)) return '';
  return text;
}

function withAmazonSearchParams(value, params) {
  try {
    const url = new URL(String(value || '').trim());
    if (!/amazon\./i.test(url.hostname)) return '';
    for (const [key, paramValue] of Object.entries(params)) {
      url.searchParams.set(key, paramValue);
    }
    return url.toString();
  } catch {
    return '';
  }
}

function shouldUseAmazonReaderFallback() {
  return String(process.env.AMAZON_READER_FALLBACK || 'true').toLowerCase() !== 'false';
}

function shouldUseEarlyListasinFallback(options = {}) {
  if (options.preferListasinFallback === false) return false;
  return String(process.env.LISTASIN_EARLY_FALLBACK || 'true').toLowerCase() !== 'false';
}

async function fetchFromAmazonReader(asin, inputUrl = '', options = {}) {
  const sourceUrl = amazonProductCandidateUrls(asin, inputUrl)[0] || amazonUrlForAsin(asin);
  const readerUrl = amazonReaderUrl(sourceUrl);
  const text = await fetchHtml(readerUrl, options);
  return extractAmazonReaderSnapshotFromText(text, asin, sourceUrl, 'amazon_reader');
}

async function fetchKindleSeriesItemsFromAmazonReader(input, options = {}) {
  const urls = [
    ...amazonReaderSeriesSeedUrls(options.readerSeriesSeedUrls),
    ...kindleSeriesCandidateUrls(input)
  ].filter((url, index, candidates) => candidates.indexOf(url) === index);
  let lastError;
  const attemptedCollections = new Set();

  for (const sourceUrl of urls) {
    try {
      const text = await fetchHtml(amazonReaderUrl(sourceUrl), options);
      const result = extractKindleSeriesItemsFromAmazonReaderText(text, input, sourceUrl, options);
      const collectionResult = await fetchResolvedCollectionFromAmazonReaderResult(
        result,
        sourceUrl,
        input,
        options,
        attemptedCollections
      );
      if (collectionResult?.items?.length > 1) return collectionResult;
      if (result.items.length > 1) return result;
      lastError = new Error('readerでシリーズ内のKindle ASINを取得できませんでした');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('readerでシリーズページを取得できませんでした');
}

function amazonReaderSeriesSeedUrls(values = []) {
  if (!Array.isArray(values)) return [];

  const urls = [];
  for (const value of values) {
    const asin = extractAsin(value);
    if (!asin || !isProbablyBookAsin(asin)) continue;
    const url = amazonUrlForAsin(asin);
    if (!urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, 3);
}

async function fetchResolvedCollectionFromAmazonReaderResult(result, sourceUrl, input, options, attemptedCollections) {
  const collectionAsin = String(result?.sourceAsin || '').toUpperCase();
  const inputAsin = extractAsin(sourceUrl) || extractAsin(input);
  if (!collectionAsin || !inputAsin || collectionAsin === inputAsin) return null;
  if (attemptedCollections.has(collectionAsin)) return null;
  attemptedCollections.add(collectionAsin);

  try {
    return await fetchKindleSeriesItems(kindleSeriesFetchUrlForAsin(collectionAsin), {
      ...options,
      allowReaderFallback: false
    });
  } catch {
    return null;
  }
}

function amazonReaderUrl(sourceUrl) {
  return `https://r.jina.ai/http://${sourceUrl}`;
}

function nonKindleProductError() {
  const error = new Error('Kindle版商品ではありません。Kindle商品ページのASINを登録してください');
  error.code = 'NON_KINDLE_PRODUCT';
  return error;
}

function isPermanentKindleProductError(error) {
  return error?.code === 'NON_KINDLE_PRODUCT' || /^Kindle版(?:ASIN|商品)ではありません/.test(String(error?.message || error || ''));
}

function isLegacyPhysicalProductAsin(asin) {
  return /^B000[A-Z0-9]{6}$/.test(String(asin || '').toUpperCase());
}

function assertKindleBookProductPage(value) {
  if (isDefiniteNonKindleBookPage(value)) throw nonKindleProductError();
}

function isDefiniteNonKindleBookPage(value) {
  const raw = String(value || '');
  const text = pageEvidenceText(raw);
  if (!text) return false;
  if (hasStrongKindleBookEvidence(raw, text)) return false;
  return hasPhysicalBookEvidence(text);
}

function pageEvidenceText(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function hasStrongKindleBookEvidence(raw, text) {
  return (
    /id=["']tmm-grid-swatch-KINDLE["']|kindleExtraMessage|ebooksProductTitle/i.test(raw) ||
    /(?:Kindle版\s*[（(]\s*電子書籍\s*[）)]|Kindle Edition|Kindle eBook|\beBook\s*:.*Kindle Store|:\s*Kindle Store\b)/i.test(text)
  );
}

function hasPhysicalBookEvidence(text) {
  return (
    /\b(?:Paperback|Tankobon|Hardcover|Shinsho|Comic|Mook)\b.{0,80}(?:[–—-]|from|USD|JPY|￥|¥)/i.test(text) ||
    /(?:単行本|文庫|新書|コミック|ムック|ペーパーバック).{0,80}(?:[–—-]|から|￥|¥|円)/i.test(text) ||
    /\bISBN(?:-1[03])?\b/i.test(text) ||
    /\b(?:Other Used and New|Used\s*(?:\([0-9]+\))?\s+from|Buy used|中古)\b/i.test(text)
  );
}

export function extractKindleSeriesItemsFromAmazonReaderText(text, input, sourceUrl, options = {}) {
  const value = String(text || '');
  const seriesName = extractAmazonReaderSeriesName(value);
  const expectedVolumeCount = extractAmazonReaderSeriesExpectedCount(value);
  const inputAsin = extractAsin(input);
  const sourceAsin = extractAmazonReaderCollectionAsin(value, inputAsin, expectedVolumeCount) || inputAsin;
  let items = extractAmazonReaderSeriesItems(value, {
    seriesName,
    expectedVolumeCount,
    sourceAsin
  });

  if (options.requireCollectionPage && !isAmazonReaderSeriesPage(value, expectedVolumeCount, items)) {
    items = [];
  }

  return buildKindleSeriesResult({
    seriesName,
    sourceAsin,
    sourcePriceSeed: null,
    expectedVolumeCount: expectedVolumeCount || maxSeriesItemVolume(items) || items.length,
    completed: extractAmazonReaderSeriesCompletionStatus(value),
    items,
    provider: 'amazon_series_reader',
    sourceUrl
  });
}

function extractAmazonReaderCollectionAsin(text, fallbackAsin = '', expectedVolumeCount = 0) {
  const value = String(text || '');
  const fallback = String(fallbackAsin || '').toUpperCase();

  for (const match of value.matchAll(/\[([^\]\n]{1,180})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const label = cleanMarkdownText(match[1] || '');
    if (!isAmazonReaderCollectionNavigationLabel(label, expectedVolumeCount)) continue;

    const href = cleanMarkdownUrl(match[2] || '');
    const asin = extractAsin(href) || extractAsin(decodeURIComponentSafe(href));
    if (!asin || !isProbablyBookAsin(asin) || asin === fallback) continue;
    return asin;
  }

  return '';
}

function isAmazonReaderCollectionNavigationLabel(label, expectedVolumeCount = 0) {
  const value = String(label || '').normalize('NFKC').trim();
  const japanese = value.match(/^全\s*([0-9]{1,4})\s*巻中\s*第\s*([0-9]{1,4})\s*巻\s*[:：]/u);
  if (japanese) {
    const total = Number(japanese[1]);
    return total > 1 && (!expectedVolumeCount || total === Number(expectedVolumeCount));
  }

  const english = value.match(/^Book\s*([0-9]{1,4})\s+of\s+([0-9]{1,4})\s*[:：]/i);
  if (english) {
    const total = Number(english[2]);
    return total > 1 && (!expectedVolumeCount || total === Number(expectedVolumeCount));
  }

  return false;
}

function extractAmazonReaderSeriesName(text) {
  const heading =
    String(text || '').match(/^\s*#\s+(.+?\([0-9０-９]+\s+book\s+series\).*?)$/im)?.[1] ||
    String(text || '').match(/^\s*Title:\s*(.+?\([0-9０-９]+\s+book\s+series\).*?)$/im)?.[1] ||
    String(text || '').match(/^\s*#\s+(.+)$/m)?.[1] ||
    '';

  return cleanAmazonSeriesName(
    cleanTitle(heading)
      .replace(/^Amazon\.co\.jp:\s*/i, '')
      .replace(/\s*\(\s*[0-9０-９]+\s+book\s+series\s*\)\s*Kindle Edition.*$/i, '')
      .replace(/\s*Kindle Edition.*$/i, '')
      .replace(/\s*:\s*Kindle Store.*$/i, '')
      .trim()
  );
}

function extractAmazonReaderSeriesExpectedCount(text) {
  const value = cleanText(text);
  const patterns = [
    /\(\s*([0-9０-９]{1,3})\s+book\s+series\s*\)/gi,
    /There are\s+([0-9０-９]{1,3})\s+volumes?\s+in\s+this\s+series/gi,
    /This option includes\s+([0-9０-９]{1,3})\s+volumes/gi,
    /All\s+([0-9０-９]{1,3})\s+Kindle/gi
  ];
  const counts = [];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const count = Number(toHalfWidthNumber(match?.[1] || ''));
      if (Number.isFinite(count) && count > 0) counts.push(count);
    }
  }

  if (counts.length) return Math.max(...counts);
  return extractVolumeCount(value);
}

function extractAmazonReaderSeriesItems(text, options = {}) {
  const expectedVolumeCount = Number(options.expectedVolumeCount) || 0;
  const seriesName = options.seriesName || '';
  const sourceAsin = String(options.sourceAsin || '').toUpperCase();
  const block = extractAmazonReaderSeriesBlock(text);
  const candidates = preferredAmazonReaderSeriesLinkCandidates(
    extractAmazonReaderSeriesLinkCandidates(block),
    expectedVolumeCount
  )
    .filter((candidate) => candidate.asin !== sourceAsin)
    .filter((candidate) => isAmazonReaderSeriesLinkCandidate(candidate, seriesName, expectedVolumeCount))
    .sort((left, right) => left.index - right.index);
  const items = [];
  const byAsin = new Map();

  for (const candidate of candidates) {
    const existing = byAsin.get(candidate.asin);
    if (existing) {
      existing.title = betterText(existing.title, candidate.title);
      if (!existing.imageUrl && candidate.imageUrl) {
        existing.imageUrl = candidate.imageUrl;
        existing.imageSource = 'amazon_series_reader';
      }
      if (existing.currentPrice == null && candidate.currentPrice != null) {
        existing.currentPrice = candidate.currentPrice;
        existing.currentPoints = candidate.currentPoints;
        existing.effectivePrice = candidate.effectivePrice;
      }
      continue;
    }

    if (expectedVolumeCount > 0 && items.length >= expectedVolumeCount) break;

    const volume = readerSeriesVolumeFromCandidate(candidate, items.length + 1, expectedVolumeCount);
    const item = {
      asin: candidate.asin,
      title: cleanAmazonReaderSeriesItemTitle(candidate.title, candidate.asin, seriesName, volume),
      imageUrl: candidate.imageUrl || '',
      imageSource: candidate.imageUrl ? 'amazon_series_reader' : '',
      amazonUrl: amazonUrlForAsin(candidate.asin),
      volume,
      currentPrice: candidate.currentPrice,
      currentPoints: candidate.currentPoints,
      effectivePrice: candidate.effectivePrice,
      listPrice: null,
      provider: 'amazon_series_reader'
    };
    items.push(item);
    byAsin.set(candidate.asin, item);
  }

  return dedupeSeriesItems(items);
}

function extractAmazonReaderSeriesBlock(text) {
  const value = String(text || '');
  const startPatterns = [
    /^\s*#\s+.+?\([0-9０-９]+\s+book\s+series\).*$/im,
    /There are\s+[0-9０-９]{1,3}\s+volumes?\s+in\s+this\s+series/i,
    /This option includes\s+[0-9０-９]{1,3}\s+volumes/i
  ];
  const starts = startPatterns
    .map((pattern) => value.search(pattern))
    .filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : 0;
  const suffix = value.slice(start + 1);
  const endPatterns = [
    /^##\s+Report an issue/im,
    /^##\s+Product details/im,
    /^##\s+From the Publisher/im,
    /^##\s+Customers/im,
    /^##\s+Products related/im,
    /^###\s+Product details/im,
    /^###\s+Popular/im,
    /^##\s+この商品をチェックした人/im,
    /^##\s+この商品に関連する商品/im,
    /^##\s+関連商品/im,
    /^##\s+商品の説明/im,
    /^##\s+登録情報/im
  ];
  const endOffsets = endPatterns
    .map((pattern) => suffix.search(pattern))
    .filter((index) => index >= 0);
  const end = endOffsets.length ? start + 1 + Math.min(...endOffsets) : value.length;
  return value.slice(start, end);
}

function extractAmazonReaderSeriesLinkCandidates(text) {
  const value = String(text || '');
  const candidates = [];

  for (const match of value.matchAll(/\[(?:[0-9]{1,4}\s*)?!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\s*([^\]\n]{0,300})\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g)) {
    const href = cleanMarkdownUrl(match[4]);
    const asin = extractAsin(href) || extractAsin(decodeURIComponentSafe(href));
    const imageUrl = decodeHtml(match[2]);
    if (!asin || !isProbablyBookAsin(asin)) continue;
    const pricing = extractAmazonReaderSeriesCandidatePricing(value, match.index ?? 0, match[0].length);
    candidates.push({
      asin,
      href,
      title: cleanMarkdownText(match[5] || match[3] || match[1] || ''),
      alt: cleanMarkdownText(match[1] || ''),
      imageUrl: isAmazonImage(imageUrl) ? imageUrl : '',
      index: match.index ?? 0,
      kind: 'image',
      ...pricing
    });
  }

  for (const match of value.matchAll(/\[([^\]\n]{1,300})\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g)) {
    const rawTitle = match[1] || '';
    if (rawTitle.startsWith('!')) continue;
    const href = cleanMarkdownUrl(match[2]);
    const asin = extractAsin(href) || extractAsin(decodeURIComponentSafe(href));
    if (!asin || !isProbablyBookAsin(asin)) continue;
    const pricing = extractAmazonReaderSeriesCandidatePricing(value, match.index ?? 0, match[0].length);
    candidates.push({
      asin,
      href,
      title: cleanMarkdownText(match[3] || rawTitle),
      alt: '',
      imageUrl: '',
      index: match.index ?? 0,
      kind: 'link',
      ...pricing
    });
  }

  return candidates;
}

function extractAmazonReaderSeriesCandidatePricing(text, index, matchLength) {
  const context = amazonReaderSeriesCandidateContext(text, index, matchLength);
  if (!/\bKindle(?:版| Edition)?\b/i.test(context)) {
    return { currentPrice: null, currentPoints: 0, effectivePrice: null };
  }

  const price =
    parsePrice(context.match(/\bKindle(?:版| Edition)?\b[\s\S]{0,500}?(?:￥|¥)\s*([0-9][0-9,]*)/i)?.[1]) ??
    parsePrice(context.match(/\bKindle(?:版| Edition)?\b[\s\S]{0,500}?\bJPY\s*([0-9][0-9,]*)/i)?.[1]);
  if (price == null) {
    return { currentPrice: null, currentPoints: 0, effectivePrice: null };
  }

  const points =
    parseOptionalPoints(
      context.match(/([0-9][0-9,]*)\s*(?:ポイント|pt)\s*(?:\([0-9]{1,3}%\))?/i)?.[1]
    ) ?? 0;
  return {
    currentPrice: price,
    currentPoints: points,
    effectivePrice: Math.max(0, price - points)
  };
}

function amazonReaderSeriesCandidateContext(text, index, matchLength) {
  const value = String(text || '');
  const start = Math.max(0, value.lastIndexOf('\n', Math.max(0, index - 1)) + 1);
  const afterMatch = Math.max(start, index + matchLength);
  const boundedEnd = Math.min(value.length, afterMatch + 1600);
  const suffix = value.slice(afterMatch, boundedEnd);
  const nextItemOffset = suffix.search(/\n\s*[0-9]{1,4}\.\s+/);
  const nextSectionOffset = suffix.search(/\n\s*#{1,3}\s+/);
  const offsets = [nextItemOffset, nextSectionOffset].filter((offset) => offset >= 0);
  const end = offsets.length ? afterMatch + Math.min(...offsets) : boundedEnd;
  return cleanText(value.slice(start, end));
}

function preferredAmazonReaderSeriesLinkCandidates(candidates, expectedVolumeCount) {
  const imageCandidates = candidates.filter((candidate) => candidate.kind === 'image' && candidate.imageUrl);
  if (imageCandidates.length > 1) {
    const uniqueImageAsins = new Set(imageCandidates.map((candidate) => candidate.asin));
    if (!expectedVolumeCount || uniqueImageAsins.size >= Math.min(expectedVolumeCount, 2)) {
      return imageCandidates;
    }
  }
  return candidates;
}

function cleanMarkdownUrl(value) {
  return decodeHtml(String(value || '').trim().replace(/^<|>$/g, ''));
}

function cleanMarkdownText(value) {
  return cleanTitle(
    decodeHtml(String(value || '').replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1'))
  );
}

function isAmazonReaderSeriesLinkCandidate(candidate, seriesName, expectedVolumeCount) {
  if (!candidate?.asin || !isProbablyBookAsin(candidate.asin)) return false;
  if (isAmazonReaderNoiseLinkCandidate(candidate)) return false;

  const href = decodeURIComponentSafe(candidate.href || '');
  if (/saga_(?:sdp|dp)|hulkbuy|dbs_|dbs-|series|binding=kindle_edition|kindle_edition/i.test(href)) {
    return true;
  }

  const normalizedSeriesName = normalizeReaderImageText(seriesName);
  const normalizedTitle = normalizeReaderImageText(`${candidate.title || ''} ${candidate.alt || ''}`);
  const titleHasExplicitVolume = Boolean(
    extractExternalVolumeFromTitle(candidate.title) || extractExternalVolumeFromTitle(candidate.alt)
  );
  if (
    normalizedSeriesName &&
    normalizedSeriesName !== normalizeReaderImageText('Kindle シリーズ') &&
    normalizedTitle.includes(normalizedSeriesName) &&
    titleHasExplicitVolume
  ) {
    return true;
  }

  return false;
}

function isAmazonReaderNoiseLinkCandidate(candidate) {
  const href = decodeURIComponentSafe(candidate.href || '');
  const title = cleanText(`${candidate.title || ''} ${candidate.alt || ''}`);

  return (
    /customerReviews|product-reviews|\/ap\/signin|\/ap\/register|#customerReviews/i.test(href) ||
    isSeriesNavigationPseudoTitle(title) ||
    /^(?:See included items|Share this item|Sold by:|Amazon\.co\.jp)$/i.test(title) ||
    /\bout of 5 stars\b/i.test(title)
  );
}

function readerSeriesVolumeFromCandidate(candidate, fallbackIndex, expectedVolumeCount) {
  return (
    extractExternalVolumeFromTitle(candidate.title) ||
    extractExternalVolumeFromTitle(candidate.alt) ||
    readerJapaneseVolumeWord(candidate.title, expectedVolumeCount) ||
    readerJapaneseVolumeWord(candidate.alt, expectedVolumeCount) ||
    String(fallbackIndex)
  );
}

function readerJapaneseVolumeWord(text, expectedVolumeCount) {
  const value = cleanTitle(text);
  if (/(?:^|[　\s（(])上(?:巻)?(?:$|[　\s）)])/u.test(value)) return '1';
  if (/(?:^|[　\s（(])中(?:巻)?(?:$|[　\s）)])/u.test(value)) return '2';
  if (/(?:^|[　\s（(])下(?:巻)?(?:$|[　\s）)])/u.test(value)) {
    return expectedVolumeCount > 0 && expectedVolumeCount <= 3 ? String(expectedVolumeCount) : '3';
  }
  return '';
}

function cleanAmazonReaderSeriesItemTitle(title, asin, seriesName, volume) {
  const cleaned = cleanTitle(title)
    .replace(/^Image\s+\d+\s*:\s*/i, '')
    .replace(/\s*Kindle Edition.*$/i, '')
    .trim();
  if (cleaned && !/^ASIN\s+[A-Z0-9]{10}$/i.test(cleaned)) return cleaned;
  return `${seriesName || 'Kindle シリーズ'} ${volume || asin}`.trim();
}

function isAmazonReaderSeriesPage(text, expectedVolumeCount, items) {
  const value = cleanText(text);
  return (
    expectedVolumeCount > 1 ||
    (items.length > 1 && /\bbook\s+series\b|volumes?\s+in\s+this\s+series|This option includes/i.test(value))
  );
}

function extractAmazonReaderSeriesCompletionStatus(text) {
  const value = cleanText(text);
  return (
    /(?:全\s*)?[0-9０-９]{1,3}\s*巻\s*(?:完結|完)/.test(value) ||
    /(?:完結済み|完結作品|シリーズ完結|全巻完結)/.test(value) ||
    /\b(?:completed|complete)\s+series\b/i.test(value)
  );
}

function extractAmazonReaderSnapshotFromText(text, asin, url, provider) {
  const value = String(text || '');
  assertKindleBookProductPage(value);
  const title = extractAmazonReaderTitle(value);
  return normalizeSnapshot({
    asin,
    title,
    author: extractAmazonReaderAuthor(value),
    publisher: '',
    imageUrl: extractAmazonReaderImage(value, title),
    amazonUrl: amazonUrlForAsin(asin),
    currentPrice: extractAmazonReaderCurrentPrice(value),
    currentPoints: extractAmazonReaderPoints(value),
    listPrice: null,
    provider
  });
}

function extractAmazonReaderTitle(text) {
  const rawTitle = text.match(/^Title:\s*(.+)$/im)?.[1] || text.match(/^#\s+(.+)$/m)?.[1] || '';
  return cleanTitle(rawTitle)
    .replace(/^Amazon\.co\.jp:\s*/i, '')
    .replace(/\s+eBook\s*:.*$/i, '')
    .replace(/\s*:\s*Kindle Store.*$/i, '')
    .trim();
}

function extractAmazonReaderAuthor(text) {
  const rawTitle = text.match(/^Title:\s*(.+)$/im)?.[1] || text.match(/^#\s+(.+)$/m)?.[1] || '';
  const author = rawTitle.match(/\beBook\s*:\s*([^:]+?)\s*:\s*Kindle Store/i)?.[1];
  return cleanContributorText(author || '');
}

function extractAmazonReaderImage(text, title = '') {
  const images = [];
  for (const match of String(text || '').matchAll(/!\[[^\]]*?\]\((https?:\/\/[^)]+)\)/g)) {
    const url = decodeHtml(match[1]);
    if (!isAmazonImage(url)) continue;
    if (!/\/images\/I\//i.test(url)) continue;
    images.push({
      alt: match[0].match(/^!\[([^\]]*)\]/)?.[1] || '',
      url,
      index: match.index ?? 0
    });
  }
  return images.sort((left, right) => readerImageScore(right, title) - readerImageScore(left, title))[0]?.url || '';
}

function readerImageScore(image, title = '') {
  const value = String(image?.url || '');
  const titleText = normalizeReaderImageText(title);
  const altText = normalizeReaderImageText(image?.alt || '');
  let score = 0;
  if (titleText && altText) {
    if (altText === titleText) score += 140;
    else if (altText.includes(titleText)) score += 120;
    else if (titleText.includes(altText)) score += 80;
  }
  if (/\/images\/I\/[A-Za-z0-9_.-]+(?:_SL|_SY|_SX)[0-9]+_/i.test(value)) score += 20;
  if (/\.jpg|\.jpeg|\.png|\.webp/i.test(value)) score += 10;
  if (/_AC_|_FM|_PQ|grey-pixel|sprite|logo|sash/i.test(value)) score -= 20;
  if (Number.isFinite(image?.index)) score -= Math.min(image.index / 10000, 20);
  return score + Math.min(value.length, 200) / 1000;
}

function normalizeReaderImageText(value) {
  return cleanText(value)
    .replace(/^image\s+\d+\s*:\s*/i, '')
    .replace(/\s+/g, '')
    .replace(/[・:：\-‐‑‒–—―_＿|｜]/g, '')
    .toLowerCase();
}

function extractAmazonReaderCurrentPrice(text) {
  const value = cleanText(text);
  const patterns = [
    /charged\s+JPY\s*([0-9][0-9,]*)/i,
    /(?:Kindle|Digital)[^\n。]{0,160}\bJPY\s*([0-9][0-9,]*)/i,
    /(?:Kindle|Digital|Kindle版)[^\n。]{0,160}(?:￥|¥)\s*([0-9][0-9,]*)/i,
    /(?:Kindle|Digital|Kindle版)[^\n。]{0,160}([0-9][0-9,]*)\s*円/i
  ];

  for (const pattern of patterns) {
    const price = parsePrice(value.match(pattern)?.[1]);
    if (price != null) return price;
  }

  return null;
}

function extractAmazonReaderPoints(text) {
  const value = cleanText(text);
  const patterns = [
    /Amazon Points:\s*\+?\s*([0-9][0-9,]*)\s*pt/i,
    /\(([0-9][0-9,]*)\s*pt\)/i,
    /([0-9][0-9,]*)\s*ポイント/
  ];

  for (const pattern of patterns) {
    const points = parseOptionalPoints(value.match(pattern)?.[1]);
    if (points != null) return points;
  }

  return 0;
}

function mergeSnapshotLike(base, overlay) {
  const shouldUseOverlayPricing = base.currentPrice == null && overlay.currentPrice != null;
  return {
    ...base,
    title: bestSnapshotTitle(base.title, overlay.title),
    author: base.author || overlay.author,
    publisher: base.publisher || overlay.publisher,
    imageUrl: base.imageUrl || overlay.imageUrl,
    currentPrice: shouldUseOverlayPricing ? overlay.currentPrice : base.currentPrice ?? overlay.currentPrice,
    currentPoints: shouldUseOverlayPricing ? overlay.currentPoints : base.currentPoints ?? overlay.currentPoints,
    effectivePrice: shouldUseOverlayPricing ? overlay.effectivePrice : base.effectivePrice ?? overlay.effectivePrice,
    listPrice: shouldUseOverlayPricing ? overlay.listPrice : base.listPrice ?? overlay.listPrice,
    provider: shouldUseOverlayPricing ? overlay.provider : base.provider
  };
}

function snapshotWithoutPrice(snapshot = {}) {
  return {
    ...snapshot,
    currentPrice: null,
    currentPoints: 0,
    effectivePrice: null
  };
}

export function shouldDeferAmazonReaderPrice(snapshot = {}, options = {}) {
  if (String(snapshot.provider || '').toLowerCase() !== 'amazon_reader') return false;
  const price = Number(snapshot.currentPrice);
  if (!Number.isFinite(price) || price < 0) return false;
  if (price <= 5) return true;

  const references = [
    snapshot.listPrice,
    options.listPrice,
    options.currentPrice,
    options.effectivePrice,
    options.previousEffectivePrice
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 100);
  const reference = references.length ? Math.max(...references) : 0;
  return reference > 0 && price <= reference * 0.7;
}

function bestSnapshotTitle(primary, fallback) {
  const first = cleanTitle(primary);
  const second = cleanTitle(fallback);
  if (!first) return second;
  if (second && isPlaceholderSnapshotTitle(first) && !isPlaceholderSnapshotTitle(second)) return second;
  return first;
}

function isPlaceholderSnapshotTitle(title) {
  return /^ASIN\s+[A-Z0-9]{10}(?:\s*[（(].*?[）)])?$/i.test(cleanTitle(title));
}

function amazonFetchUrlLabel(value) {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search ? '?...' : ''}`;
  } catch {
    return 'amazon';
  }
}

function compactFetchErrors(errors) {
  const unique = [...new Set(errors.map((error) => String(error || '').trim()).filter(Boolean))];
  if (unique.length <= 4) return unique.join(' / ');

  const listasinError = unique.findLast((error) => error.startsWith('listasIn:'));
  const kintyakuError = unique.findLast((error) => error.startsWith('Kintyaku:'));
  const readerError = unique.findLast((error) => error.startsWith('reader:'));
  const searchError = unique.findLast((error) => error.startsWith('/s?'));
  return [...new Set([...unique.slice(0, readerError ? 2 : 3), searchError, readerError, kintyakuError, listasinError].filter(Boolean))].join(' / ');
}

export function extractAmazonHtmlSnapshotFromHtml(html, asin, url, provider = 'amazon_html', options = {}) {
  assertKindleBookProductPage(html);
  const base = extractAmazonHtmlSnapshotBase(html, asin, url, provider);
  const kindleOffer = extractKindlePurchaseOffer(html, asin);
  const allPrices = extractPrices(html);
  let currentPrice = kindleOffer.price ?? chooseLikelyKindlePrice(allPrices, html);
  let listPrice = extractListPrice(html, listPriceReferencePrice(currentPrice, options));
  const inferredPrice = inferDiscountedKindlePrice(html, listPrice);
  if (shouldPreferInferredDiscountPrice({ currentPrice, inferredPrice, listPrice, html, explicitOffer: isExplicitKindleOffer(kindleOffer) })) {
    currentPrice = inferredPrice;
  }
  let currentPoints =
    kindleOffer.price != null
      ? kindleOffer.points ?? extractKindlePurchasePoints(html, currentPrice) ?? 0
      : extractPointsNearPrice(html, currentPrice) ?? extractKindlePurchasePoints(html, currentPrice) ?? extractPoints(html, currentPrice);
  const corrected = correctImplausibleKindlePrice({ currentPrice, currentPoints, listPrice, prices: allPrices, html });
  currentPrice = corrected.currentPrice;
  currentPoints = corrected.currentPoints;
  listPrice = extractListPrice(html, listPriceReferencePrice(currentPrice, options)) ?? listPrice;
  const explicitPriceDisplay = currentPrice != null && hasExplicitPriceDisplay(html, currentPrice);
  const explicitFreeKindlePrice = currentPrice === 0 && (explicitPriceDisplay || hasExplicitFreeKindlePrice(html));

  return normalizeSnapshot({
    ...base,
    currentPrice,
    listPrice,
    currentPoints,
    explicitPriceDisplay,
    explicitFreeKindlePrice
  });
}

function extractAmazonSearchSnapshotFromHtml(html, asin, url, provider, options = {}) {
  const fragment = extractAmazonSearchResultFragment(html, asin);
  if (!fragment) throw new Error('Amazon検索結果に商品が見つかりません');
  assertKindleBookProductPage(fragment);

  const prices = extractPrices(fragment);
  let currentPrice = chooseLikelyKindlePrice(prices, fragment);
  const title =
    cleanTitle(fragment.match(/<h2\b[^>]*aria-label=["']([^"']+)["']/i)?.[1] || '') ||
    cleanTitle(fragment.match(/<h2\b[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '') ||
    extractItemTitle(fragment, asin);
  const imageUrl = extractItemImage(fragment);
  const productUrl = absoluteAmazonHref(extractAsinHref(fragment, asin)) || amazonUrlForAsin(asin);
  let listPrice = extractListPrice(fragment, listPriceReferencePrice(currentPrice, options));
  const inferredPrice = inferDiscountedKindlePrice(fragment, listPrice);
  if (shouldPreferInferredDiscountPrice({ currentPrice, inferredPrice, listPrice, html: fragment })) {
    currentPrice = inferredPrice;
  }
  let currentPoints = extractPointsNearPrice(fragment, currentPrice) ?? extractPoints(fragment, currentPrice);
  const corrected = correctImplausibleKindlePrice({ currentPrice, currentPoints, listPrice, prices, html: fragment });
  currentPrice = corrected.currentPrice;
  currentPoints = corrected.currentPoints;
  listPrice = extractListPrice(fragment, listPriceReferencePrice(currentPrice, options)) ?? listPrice;
  const explicitPriceDisplay = currentPrice != null && hasExplicitPriceDisplay(fragment, currentPrice);
  const explicitFreeKindlePrice = currentPrice === 0 && (explicitPriceDisplay || hasExplicitFreeKindlePrice(fragment));

  return normalizeSnapshot({
    asin,
    title,
    author: extractSearchResultAuthor(fragment),
    publisher: '',
    imageUrl,
    amazonUrl: productUrl,
    currentPrice,
    currentPoints,
    listPrice,
    provider,
    explicitPriceDisplay,
    explicitFreeKindlePrice
  });
}

function extractAmazonSearchResultFragment(html, asin) {
  const value = String(html || '');
  const normalizedAsin = String(asin || '').toUpperCase();
  const asinPattern = escapeRegExp(normalizedAsin);
  const match = value.match(new RegExp(`\\bdata-asin=["']${asinPattern}["']`, 'i'));
  if (!match) return '';

  const index = match.index || 0;
  const startCandidates = [
    lastPatternIndex(value, /<div\b[^>]*data-component-type=["']s-search-result["'][^>]*>/gi, index),
    value.lastIndexOf('<div role="listitem"', index),
    value.lastIndexOf('<div', index)
  ].filter((position) => position >= 0);
  const start = startCandidates.length ? Math.max(...startCandidates) : Math.max(0, index - 2000);
  const nextItem = value.indexOf('<div role="listitem"', index + normalizedAsin.length);
  const nextSearchResult = nextPatternIndex(value, /<div\b[^>]*data-component-type=["']s-search-result["'][^>]*>/gi, index + normalizedAsin.length);
  const nextDataAsin = nextPatternIndex(value, /\bdata-asin=["'][A-Z0-9]{10}["']/gi, index + normalizedAsin.length);
  const endCandidates = [nextItem, nextSearchResult, nextDataAsin].filter((position) => position > index);
  const end = endCandidates.length ? Math.min(...endCandidates) : Math.min(value.length, index + 12000);
  return value.slice(start, end);
}

function lastPatternIndex(value, pattern, beforeIndex) {
  let last = -1;
  for (const match of String(value || '').matchAll(pattern)) {
    if ((match.index ?? -1) >= beforeIndex) break;
    last = match.index ?? -1;
  }
  return last;
}

function nextPatternIndex(value, pattern, fromIndex) {
  pattern.lastIndex = Math.max(0, fromIndex);
  const match = pattern.exec(String(value || ''));
  return match?.index ?? -1;
}

function extractSearchResultAuthor(fragment) {
  const candidates = [];
  for (const match of String(fragment || '').matchAll(/<a\b[^>]*href=["'][^"']*\/e\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const author = cleanContributorText(match[1]);
    if (author && !candidates.includes(author)) candidates.push(author);
  }
  return candidates.slice(0, 3).join(', ');
}

function extractAsinHref(fragment, asin) {
  const pattern = new RegExp(`href=["']([^"']*(?:\\/dp\\/|\\/gp\\/product\\/)${escapeRegExp(String(asin || ''))}[^"']*)["']`, 'i');
  return decodeHtml(String(fragment || '').match(pattern)?.[1] || '');
}

function absoluteAmazonHref(href) {
  if (!href) return '';
  try {
    return new URL(href, `https://${process.env.AMAZON_HOST || 'www.amazon.co.jp'}`).toString();
  } catch {
    return '';
  }
}

function extractAmazonHtmlSnapshotBase(html, asin, url, provider) {
  const title = cleanText(
    extractById(html, 'productTitle') ||
      extractMeta(html, 'og:title') ||
      extractTag(html, 'title')
  );
  const author = cleanContributorText(extractContributor(html));
  const publisher = cleanMetadataText(extractDetail(html, /出版社|Publisher/i));
  const releaseDate = extractAmazonReleaseDate(html);
  const imageUrl = extractMeta(html, 'og:image') || extractLandingImage(html);

  return {
    asin,
    title,
    author,
    publisher,
    releaseDate,
    imageUrl,
    amazonUrl: url,
    provider
  };
}

function isAmazonSearchUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return /amazon\./i.test(url.hostname) && /^\/s\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function extractSeriesSourcePriceSeedFromHtml(html, asin, url, items = []) {
  const expectedCount = maxSeriesItemVolume(items) || items.length;
  const unitPrice = extractBulkOfferUnitPrice(html, expectedCount);
  if (unitPrice != null) {
    return normalizeSnapshot({
      ...extractAmazonHtmlSnapshotBase(html, asin, url, 'amazon_series_unit_price'),
      currentPrice: unitPrice,
      listPrice: null,
      currentPoints: extractPointsNearPrice(html, unitPrice)
    });
  }

  return safeExtractAmazonHtmlSnapshotFromHtml(html, asin, url, 'amazon_series_source_price');
}

function safeExtractAmazonHtmlSnapshotFromHtml(html, asin, url, provider) {
  try {
    return extractAmazonHtmlSnapshotFromHtml(html, asin, url, provider);
  } catch {
    return null;
  }
}

async function fetchAmazonHtml(url, options = {}) {
  return fetchHtml(url, {
    ...options,
    headers: amazonRequestHeaders(url),
    proxyTemplate: process.env.AMAZON_HTML_PROXY_URL_TEMPLATE,
    rejectRobotCheck: true,
    retries: options.retries ?? process.env.HTTP_AMAZON_FETCH_RETRIES ?? 1,
    retryDelayMs: options.retryDelayMs ?? process.env.HTTP_FETCH_RETRY_DELAY_MS ?? 1000,
    throttleUrl: url
  });
}

async function fetchHtml(url, options = {}) {
  const retries = readNonNegativeInteger(options.retries, 0);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchHtmlOnce(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetriableFetchError(error)) throw error;
      await sleepWithSignal(fetchRetryDelayMs(attempt, options), options.signal);
    }
  }

  throw lastError || new Error('HTTP取得に失敗しました');
}

async function fetchHtmlOnce(url, options = {}) {
  const timeoutMs = readPositiveInteger(
    options.timeoutMs ?? process.env.HTTP_FETCH_TIMEOUT_MS,
    DEFAULT_FETCH_TIMEOUT_MS
  );
  const { signal, cleanup } = requestSignal(options.signal, timeoutMs);
  const fetchUrl = proxiedFetchUrl(url, options.proxyTemplate);

  try {
    await waitForHostFetchSlot(options.throttleUrl || url, { ...options, signal });
    const response = await fetch(fetchUrl, { headers: options.headers || AMAZON_HEADERS, signal });
    if (!response.ok) {
      if (!shouldSkipBlockingPenalty(url, response)) {
        noteHostFetchPenalty(options.throttleUrl || url, response);
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    if (options.rejectRobotCheck && /captcha|robot check|自動化されたアクセス|ショッピングを続けてください/i.test(html)) {
      if (!shouldSkipBlockingPenalty(url, { status: 503 })) {
        noteHostFetchPenalty(options.throttleUrl || url, { status: 503 });
      }
      throw new Error('Amazonにブロックされました');
    }

    return html;
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw new Error('HTTP取得がタイムアウトしました');
    }
    throw error;
  } finally {
    cleanup();
  }
}

function amazonRequestHeaders(url) {
  const userAgents = amazonUserAgents();
  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)] || AMAZON_HEADERS['User-Agent'];
  const referer = amazonReferer(url);
  const headers = {
    ...AMAZON_HEADERS,
    'User-Agent': userAgent,
    Pragma: 'no-cache',
    DNT: '1',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1'
  };

  if (referer) headers.Referer = referer;
  return headers;
}

function amazonUserAgents() {
  const configured = String(process.env.AMAZON_USER_AGENTS || '')
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : AMAZON_USER_AGENTS;
}

function amazonReferer(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!/amazon\./i.test(parsed.hostname)) return '';
    return `${parsed.protocol}//${parsed.hostname}/`;
  } catch {
    return '';
  }
}

function proxiedFetchUrl(url, template = '') {
  const value = String(template || '').trim();
  if (!value) return url;
  if (value.includes('{url}')) return value.replaceAll('{url}', encodeURIComponent(url));

  try {
    const proxyUrl = new URL(value);
    proxyUrl.searchParams.set('url', url);
    return proxyUrl.toString();
  } catch {
    return url;
  }
}

async function fetchJson(url, options = {}) {
  const text = await fetchTextWithRetries(url, {
    ...options,
    retries: options.retries ?? process.env.JSON_FETCH_RETRIES ?? 1
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('JSONを解析できませんでした');
  }
}

async function fetchTextWithRetries(url, options = {}) {
  const retries = readNonNegativeInteger(options.retries, 0);
  const fetchOptions = { ...options };
  delete fetchOptions.retries;
  delete fetchOptions.retryDelayMs;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchHtml(url, fetchOptions);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetriableFetchError(error)) throw error;
      await sleep(fetchRetryDelayMs(attempt, options));
    }
  }

  throw lastError || new Error('HTTP取得に失敗しました');
}

async function waitForHostFetchSlot(url, options = {}) {
  if (options.skipThrottle) return;

  const host = hostnameForThrottle(url);
  if (!host) return;

  const previous = HOST_THROTTLES.get(host)?.queue || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const state = HOST_THROTTLES.get(host) || {};
    const waitMs = Math.max(0, Number(state.nextAt || 0) - Date.now());
    if (waitMs > 0) await sleepWithSignal(waitMs, options.signal);

    const current = HOST_THROTTLES.get(host) || {};
    HOST_THROTTLES.set(host, {
      ...current,
      nextAt: Date.now() + hostRequestDelayMs(host)
    });
  });

  HOST_THROTTLES.set(host, {
    ...(HOST_THROTTLES.get(host) || {}),
    queue: next
  });
  await next;
}

function noteHostFetchPenalty(url, responseLike = {}) {
  const host = hostnameForThrottle(url);
  if (!host || !isBlockingHttpStatus(responseLike.status)) return;

  const retryAfterMs = retryAfterHeaderMs(responseLike.headers?.get?.('retry-after'));
  const cooldownMs = retryAfterMs || hostBlockCooldownMs(host);
  const state = HOST_THROTTLES.get(host) || {};
  HOST_THROTTLES.set(host, {
    ...state,
    nextAt: Math.max(Number(state.nextAt || 0), Date.now() + cooldownMs)
  });
}

function hostnameForThrottle(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostRequestDelayMs(host) {
  const configured = readNonNegativeInteger(process.env.HTTP_REQUEST_MIN_INTERVAL_MS, null);
  if (configured != null) return configured + randomJitter(httpRequestJitterMs());

  const base = /amazon\./i.test(host) || host === 'r.jina.ai' ? 900 : 600;
  return base + randomJitter(httpRequestJitterMs(host));
}

function httpRequestJitterMs(host = '') {
  const configured = readNonNegativeInteger(process.env.HTTP_REQUEST_JITTER_MS, null);
  if (configured != null) return configured;
  return /amazon\./i.test(host) || host === 'r.jina.ai' ? 900 : 500;
}

function hostBlockCooldownMs(host) {
  const configured = readNonNegativeInteger(process.env.HTTP_BLOCK_COOLDOWN_MS, null);
  if (configured != null) return configured;
  return /amazon\./i.test(host) || host === 'r.jina.ai' ? 60000 : 30000;
}

function isBlockingHttpStatus(status) {
  const value = Number(status);
  return value === 403 || value === 429 || value === 503;
}

function isAmazonBlockingFetchError(error) {
  return /(?:Amazonにブロックされました|HTTP\s*(?:403|429|503)|captcha|robot check|自動化されたアクセス|ショッピングを続けてください)/i.test(
    String(error?.message || error || '')
  );
}

function retryAfterHeaderMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, timestamp - Date.now());
}

function isRetriableFetchError(error) {
  const message = String(error?.message || '');
  const code = String(error?.cause?.code || error?.code || '');
  return (
    /fetch failed|HTTP取得がタイムアウトしました|HTTP\s*(?:429|500|502|503|504)/i.test(message) ||
    /^(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/i.test(code)
  );
}

function fetchRetryDelayMs(attempt, options = {}) {
  const base = readNonNegativeInteger(options.retryDelayMs ?? process.env.JSON_FETCH_RETRY_DELAY_MS, 250);
  return base * Math.max(1, attempt + 1) + randomJitter(Math.min(base, 250));
}

function randomJitter(maxMs) {
  const max = Math.max(0, Math.round(maxMs || 0));
  return max > 0 ? Math.floor(Math.random() * (max + 1)) : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms || 0))));
}

function sleepWithSignal(ms, signal) {
  const delay = Math.max(0, Math.round(ms || 0));
  if (!signal) return sleep(delay);
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(done, delay);
    signal.addEventListener('abort', aborted, { once: true });

    function done() {
      signal.removeEventListener('abort', aborted);
      resolve();
    }

    function aborted() {
      clearTimeout(timeoutId);
      reject(abortError());
    }
  });
}

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function requestSignal(externalSignal, timeoutMs) {
  if (!externalSignal && !timeoutMs) return { signal: undefined, cleanup: () => {} };

  const controller = new AbortController();
  let timeoutId = null;
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) abort();
    else externalSignal.addEventListener('abort', abort, { once: true });
  }

  if (timeoutMs) timeoutId = setTimeout(abort, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal) externalSignal.removeEventListener('abort', abort);
    }
  };
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function normalizeSnapshot(snapshot) {
  const currentPrice = nullableNumber(snapshot.currentPrice);
  const currentPoints = nullableNumber(snapshot.currentPoints) ?? 0;
  const effectivePrice =
    currentPrice == null ? null : Math.max(0, Math.round(currentPrice - currentPoints));

  if (!snapshot.title) {
    throw new Error('タイトルを取得できませんでした');
  }
  if (isAmazonErrorPageTitle(snapshot.title)) {
    throw new Error('Amazonが商品ページではなくエラーページを返しました');
  }

  return {
    asin: snapshot.asin,
    title: snapshot.title,
    author: snapshot.author || '',
    publisher: snapshot.publisher || '',
    releaseDate: normalizeReleaseDate(snapshot.releaseDate),
    imageUrl: snapshot.imageUrl || '',
    amazonUrl: snapshot.amazonUrl || amazonUrlForAsin(snapshot.asin),
    currentPrice,
    currentPoints,
    effectivePrice,
    listPrice: nullableNumber(snapshot.listPrice),
    provider: snapshot.provider,
    explicitPriceDisplay: Boolean(snapshot.explicitPriceDisplay),
    explicitFreeKindlePrice: Boolean(snapshot.explicitFreeKindlePrice)
  };
}

function normalizeReleaseDate(value) {
  const text = cleanText(value);
  if (!text) return '';

  const numeric = text.match(/([12][0-9]{3})\s*(?:\/|年|\.|-)\s*([0-9]{1,2})\s*(?:\/|月|\.|-)\s*([0-9]{1,2})/);
  if (numeric) return formatDateParts(numeric[1], numeric[2], numeric[3]);

  const monthNames = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12
  };
  const english = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+([0-9]{1,2}),?\s+([12][0-9]{3})\b/i);
  if (english) return formatDateParts(english[3], monthNames[english[1].toLowerCase()], english[2]);

  return '';
}

function formatDateParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return '';
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isAmazonErrorPageTitle(title) {
  const value = cleanText(title).replace(/\s+/g, '');
  if (!value) return false;
  return (
    /(?:503|ServiceUnavailable|サービスが利用できません)/i.test(value) ||
    /(?:RobotCheck|CAPTCHA|ショッピングを続けてください)/i.test(value) ||
    /^Amazon\.co\.jp$/i.test(value)
  );
}

function keepaDomainId(domain) {
  const normalized = String(domain).toUpperCase();
  const map = {
    US: 1,
    UK: 2,
    DE: 3,
    FR: 4,
    JP: 5,
    CA: 6,
    CN: 7,
    IT: 8,
    ES: 9,
    IN: 10,
    MX: 11,
    BR: 12
  };
  return map[normalized] || 5;
}

function keepaPrice(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function parsePrice(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Math.round(value);
  if (typeof value === 'object') {
    return parsePrice(value.amount ?? value.value ?? value.displayAmount ?? value.raw);
  }
  if (isPercentOnlyText(value)) return null;
  const normalized = String(value).replace(/[,\s￥¥円]/g, '');
  const match = normalized.match(/\d+(?:\.\d+)?/);
  return match ? Math.round(Number(match[0])) : null;
}

function isPercentOnlyText(value) {
  const text = String(value || '').trim();
  if (!/%|％/.test(text)) return false;
  return !/(?:￥|¥|円|\bJPY\b)/i.test(text);
}

function parsePoints(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Math.round(value);
  if (typeof value === 'object') return parsePoints(value.points ?? value.value ?? value.amount);
  const match = String(value).replace(/,/g, '').match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function normalizeAmazonUrl(input) {
  const raw = String(input || '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    const asin = extractAsin(raw);
    if (asin) {
      return `${amazonUrlForAsin(asin)}?binding=kindle_edition&ref=dbs_dp_rwt_sb_pc_tkin`;
    }
    throw new Error('Amazon URLを入力してください');
  }

  if (!/amazon\./i.test(url.hostname)) {
    throw new Error('Amazon URLを入力してください');
  }

  if (extractAsin(url.toString()) && !url.searchParams.has('binding')) {
    url.searchParams.set('binding', 'kindle_edition');
    url.searchParams.set('ref', 'dbs_dp_rwt_sb_pc_tkin');
  }

  return url.toString();
}

function extractLikelySeriesSections(html) {
  const sections = [];
  const markers = [
    'dbs-title',
    'dbsTitle',
    'dbs_titles',
    'dbs_mng_crcw',
    'kindle_edition',
    'seriesAsins',
    'childAsins',
    'series-child',
    'seriesChild',
    'seriesChildren',
    'seriesBuyBox',
    'tmm-grid'
  ];

  for (const marker of markers) {
    let index = html.indexOf(marker);
    while (index !== -1) {
      const start = Math.max(0, index - 2600);
      const end = Math.min(html.length, index + 9000);
      sections.push(html.slice(start, end));
      index = html.indexOf(marker, index + marker.length);
      if (sections.length > 18) break;
    }
    if (sections.length > 18) break;
  }

  return sections;
}

function isKindleCollectionPage(html, sourceAsin = '', items = []) {
  const value = String(html || '');
  const asin = String(sourceAsin || '').toUpperCase();
  const sourceIsChildItem = Boolean(asin && items.some((item) => item.asin === asin));

  if (sourceIsChildItem) return false;
  if (asin && new RegExp(`data-parent-asins=["']${escapeRegExp(asin)}["']`, 'i').test(value)) return true;
  if (asin && new RegExp(`collectionAsin(?:&quot;|"|')\\s*:\\s*(?:&quot;|"|')${escapeRegExp(asin)}`, 'i').test(value)) {
    return true;
  }
  if (asin && new RegExp(`data-asin=["']${escapeRegExp(asin)}["'][^>]+data-entity-type=["']collection["']`, 'i').test(value)) {
    return true;
  }
  if (asin && new RegExp(`data-entity-type=["']collection["'][^>]+data-asin=["']${escapeRegExp(asin)}["']`, 'i').test(value)) {
    return true;
  }

  if (items.length <= 1) return false;

  const leadingText = cleanText(value.slice(0, 15000));
  const hasSeriesCount = /全\s*[0-9０-９]+\s*巻|[0-9０-９]+\s+book\s+series|collection/i.test(leadingText);
  const hasCollectionStructure =
    /hulk-buy-card|Kindle版\(電子書籍\)のシリーズを購入|id=["']series-childAsin-list["']|id=["']series-childAsin-item_\d+["']|まとめ買い\s*[（(]\s*巻\s*[）)]|シリーズの巻/i.test(value);
  const hasStructuredBulk = /data-offer-asins/i.test(value) && hasSeriesCount && hasStandaloneBulkSeriesEvidence(value, items);

  return hasSeriesCount && (hasCollectionStructure || hasStructuredBulk);
}

function extractSeriesCollectionAsin(html, fallbackAsin = '', items = []) {
  const value = String(html || '');
  const fallback = String(fallbackAsin || '').toUpperCase();
  const itemAsins = new Set((items || []).map((item) => String(item?.asin || '').toUpperCase()).filter(Boolean));
  const candidates = [];
  const add = (asin, options = {}) => {
    const normalized = String(asin || '').toUpperCase();
    if (!isProbablyBookAsin(normalized)) return;
    if (!options.allowItemAsin && itemAsins.has(normalized)) return;
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  for (const match of value.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = cleanText(match[2] || '');
    if (!isSeriesNavigationPseudoTitle(label)) continue;
    const asin = extractAsin(decodeHtml(match[1] || ''));
    add(asin, { allowItemAsin: true });
  }

  for (const match of value.matchAll(/collectionAsin(?:&quot;|"|')\s*:\s*(?:&quot;|"|')([A-Z0-9]{10})/gi)) {
    add(match[1]);
  }
  for (const match of value.matchAll(/data-parent-asins=["']([^"']+)["']/gi)) {
    for (const asin of match[1].match(ASIN_GLOBAL_PATTERN) || []) add(asin);
  }
  for (const match of value.matchAll(/data-asin=["']([A-Z0-9]{10})["'][^>]+data-entity-type=["']collection["']/gi)) {
    add(match[1]);
  }
  for (const match of value.matchAll(/data-entity-type=["']collection["'][^>]+data-asin=["']([A-Z0-9]{10})["']/gi)) {
    add(match[1]);
  }
  for (const match of value.matchAll(/\/kindle-dbs\/product\/([A-Z0-9]{10})/gi)) {
    add(match[1]);
  }

  if (candidates.length > 0) return candidates[0];
  return fallback;
}

function isSeriesTitleHref(href) {
  return /binding=kindle_edition|dbs_mng_crcw|dbs_mng_crcw_rwt|\/series\//i.test(href);
}

function extractChildAsinListItems(html) {
  const value = String(html || '');
  const listMatch = value.match(/<[^>]+id=["']series-childAsin-list["'][^>]*>/i);
  const hasChildItems = /id=["']series-childAsin-item_\d+["']/i.test(value);
  if (!listMatch && !hasChildItems) return [];

  const listEndMarker = '<!-- sp:end-feature:host-btf -->';
  const listStart = listMatch?.index ?? 0;
  const listEnd = value.indexOf(listEndMarker, listStart);
  const listHtml = value.slice(listStart, listEnd === -1 ? value.length : listEnd);
  const itemStarts = [...listHtml.matchAll(/<div\b[^>]+id=["']series-childAsin-item_\d+["'][^>]*>/gi)].map((match) => match.index);
  const items = [];

  for (let i = 0; i < itemStarts.length; i += 1) {
    const start = itemStarts[i];
    const end = itemStarts[i + 1] ?? listHtml.length;
    const fragment = listHtml.slice(start, end);
    const asin =
      extractAsinFromProductHref(fragment) ||
      fragment.match(/\bdata-asin=["'](B[A-Z0-9]{9})["']/i)?.[1]?.toUpperCase();

    if (!asin || !isProbablyBookAsin(asin)) continue;

    const imageUrl = extractItemImage(fragment);
    const pricing = extractSeriesChildItemPricing(fragment);
    items.push({
      asin,
      title: extractChildItemTitle(fragment, asin),
      imageUrl,
      imageSource: imageUrl ? 'amazon_series_child' : '',
      amazonUrl: amazonUrlForAsin(asin),
      ...pricing
    });
  }

  return dedupeSeriesItems(items);
}

function mergeSeriesItemsWithChildItems(items = [], childItems = []) {
  if (!childItems.length) return items;

  const childByAsin = new Map(childItems.map((item) => [item.asin, item]));
  const mergeOptions = {
    preferChildTitle: shouldPreferChildSeriesTitles(items, childItems)
  };
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const asin = String(item?.asin || '').toUpperCase();
    const childItem = childByAsin.get(asin);
    const merged = childItem ? mergeSeriesItemWithChildItem(item, childItem, mergeOptions) : item;
    if (!merged?.asin || seen.has(merged.asin)) continue;
    seen.add(merged.asin);
    result.push(merged);
  }

  for (const childItem of childItems) {
    if (!childItem?.asin || seen.has(childItem.asin)) continue;
    seen.add(childItem.asin);
    result.push(childItem);
  }

  return result;
}

function mergeSeriesItemWithChildItem(item, childItem, options = {}) {
  const merged = {
    ...item,
    title: preferredSeriesItemTitle(item, childItem, options),
    imageUrl: childItem.imageUrl || item.imageUrl || '',
    imageSource: childItem.imageUrl ? childItem.imageSource || 'amazon_series_child' : item.imageSource || '',
    amazonUrl: childItem.amazonUrl || item.amazonUrl,
    volume: item.volume || childItem.volume
  };
  return withPreferredSeriesPricing(merged, childItem, item);
}

function extractLargestBulkOfferItems(html, options = {}) {
  const value = String(html || '');
  let result = [];

  for (const match of value.matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
    const fragment = bulkOfferFormContext(value, match.index, match[0]);
    const items = extractBulkOfferItemsFromFragment(fragment, {
      ...options,
      seriesFormatKind: bulkOfferContextKind(value, match.index, fragment)
    });
    if (isBetterBulkOfferCandidate(items, result)) result = items;
  }

  const wholePageItems = extractBulkOfferItemsFromFragment(value, {
    ...options,
    seriesFormatKind: bulkOfferContextKind(value, 0, value)
  });
  if (isBetterBulkOfferCandidate(wholePageItems, result)) result = wholePageItems;

  for (const match of value.matchAll(/\bdata-offer-asins=["']([^"']+)["']/gi)) {
    const items = match[1]
      .split(',')
      .map((asin, index) =>
        bulkOfferItemFromAsin(asin.trim().toUpperCase(), index, {
          ...options,
          seriesFormatKind: bulkOfferContextKind(value, match.index, match[0])
        })
      )
      .filter(Boolean);
    if (isBetterBulkOfferCandidate(items, result)) result = items;
  }

  return dedupeSeriesItems(result);
}

function bulkOfferFormContext(pageHtml, formIndex, formHtml) {
  const value = String(pageHtml || '');
  const index = Number(formIndex);
  if (!Number.isFinite(index) || index <= 0) return String(formHtml || '');

  const windowStart = Math.max(0, index - 6000);
  const before = value.slice(windowStart, index);
  const markers = [
    '獲得ポイント',
    'data-component-id="buyboxPriceComponent"',
    'data-component-id="buyBoxPriceComponent"',
    'Kindle 価格'
  ];
  const relativeStart = Math.max(...markers.map((marker) => before.lastIndexOf(marker)));
  const start = relativeStart >= 0 ? windowStart + relativeStart : index;
  return value.slice(start, index + String(formHtml || '').length);
}

function extractLargestBulkOfferAsins(html) {
  return extractLargestBulkOfferItems(html).map((item) => item.asin);
}

function extractBulkOfferItemsFromFragment(fragment, options = {}) {
  const records = new Map();

  for (const match of String(fragment || '').matchAll(/<input\b[^>]*>/gi)) {
    const input = match[0];
    const name = extractAttribute(input, 'name');
    const value = extractAttribute(input, 'value');
    const field = name.match(/^items\[(\d+)\]\.action\.(asin|displayedPrice\.value|displayedPrice\.currency)$/i);
    if (!field) continue;

    const index = Number(field[1]);
    if (!Number.isInteger(index) || index < 0) continue;

    const record = records.get(index) || {};
    if (field[2].toLowerCase() === 'asin') record.asin = value.toUpperCase();
    if (field[2].toLowerCase() === 'displayedprice.value') record.price = parsePrice(value);
    if (field[2].toLowerCase() === 'displayedprice.currency') record.currency = value;
    records.set(index, record);
  }

  const items = [...records.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, record]) => {
      if (record.currency && !/^JPY$/i.test(record.currency)) return null;
      const item = bulkOfferItemFromAsin(record.asin, index, options);
      if (!item) return null;
      if (record.price != null) {
        item.currentPrice = record.price;
        item.currentPoints = 0;
        item.effectivePrice = record.price;
        item.provider = 'amazon_series_bulk';
      }
      return item;
    })
    .filter(Boolean);
  return withBulkOfferTotalPoints(items, fragment);
}

function withBulkOfferTotalPoints(items = [], fragment = '') {
  if (!items.length) return items;

  const totalPoints = extractBulkOfferTotalPoints(fragment);
  if (totalPoints == null || totalPoints <= 0) return items;

  const allocations = allocateBulkOfferPoints(items, totalPoints);
  if (!allocations.size) return items;

  return items.map((item, index) => {
    const points = allocations.get(index);
    if (points == null || item.currentPrice == null) return item;

    const currentPrice = Number(item.currentPrice);
    const currentPoints = sanitizePoints(points, currentPrice);
    return {
      ...item,
      currentPoints,
      effectivePrice: Math.max(0, Math.round(currentPrice - currentPoints))
    };
  });
}

function extractBulkOfferTotalPoints(fragment = '') {
  const text = cleanText(fragment);
  const patterns = [
    /獲得ポイント\s*:?\s*([0-9０-９,，]+)\s*(?:pt|ポイント)/iu,
    /([0-9０-９,，]+)\s*pt\s*\(\s*[0-9０-９]{1,3}\s*%\s*\)/iu
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const points = parseOptionalPoints(toHalfWidthNumber(match?.[1] || ''));
    if (points != null) return points;
  }

  return null;
}

function allocateBulkOfferPoints(items = [], totalPoints) {
  const pointTotal = Math.round(Number(totalPoints));
  if (!Number.isFinite(pointTotal) || pointTotal <= 0) return new Map();

  const priced = items
    .map((item, index) => ({
      index,
      price: Number(item?.currentPrice)
    }))
    .filter((entry) => Number.isFinite(entry.price) && entry.price > 0);
  const totalPrice = priced.reduce((sum, entry) => sum + entry.price, 0);
  if (totalPrice <= 0 || pointTotal > totalPrice) return new Map();

  const allocations = new Map();
  let assigned = 0;
  const fractional = priced.map((entry) => {
    const raw = (pointTotal * entry.price) / totalPrice;
    const base = Math.min(entry.price, Math.floor(raw));
    allocations.set(entry.index, base);
    assigned += base;
    return {
      ...entry,
      fraction: raw - base
    };
  });

  let remaining = pointTotal - assigned;
  for (const entry of fractional.sort((left, right) => right.fraction - left.fraction)) {
    if (remaining <= 0) break;
    const current = allocations.get(entry.index) || 0;
    if (current >= entry.price) continue;
    allocations.set(entry.index, current + 1);
    remaining -= 1;
  }

  return remaining === 0 ? allocations : new Map();
}

function bulkOfferItemFromAsin(asin, index, options = {}) {
  const normalized = String(asin || '').toUpperCase();
  if (!isProbablyBookAsin(normalized)) return null;

  const volume = index + 1;
  return {
    asin: normalized,
    title: options.seriesName ? `${options.seriesName} ${toFullWidthNumber(volume)}` : `ASIN ${normalized}`,
    imageUrl: options.seriesImageUrl || '',
    imageSource: options.seriesImageUrl ? 'series_fallback' : '',
    amazonUrl: amazonUrlForAsin(normalized),
    volume,
    seriesFormatKind: options.seriesFormatKind || '',
    provider: 'amazon_series_bulk'
  };
}

function isBetterBulkOfferCandidate(candidate, current) {
  if (!candidate.length) return false;
  const candidateRank = bulkOfferSeriesFormatRank(candidate);
  const currentRank = bulkOfferSeriesFormatRank(current);
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  if (candidate.length !== current.length) return candidate.length > current.length;
  return countPricedItems(candidate) > countPricedItems(current);
}

function bulkOfferSeriesFormatRank(items = []) {
  const kind = String(items.find((item) => item?.seriesFormatKind)?.seriesFormatKind || '');
  if (kind === 'volume') return 3;
  if (kind === 'unknown') return 2;
  if (kind === 'mixed') return 1;
  if (kind === 'episode') return 0;
  return items.length ? 2 : -1;
}

function bulkOfferContextKind(pageHtml, index, fragment = '') {
  const value = String(pageHtml || '');
  const before = value.slice(Math.max(0, Number(index) - 12000), Math.max(0, Number(index)));
  const label = lastBulkOfferLabelKind(before);
  if (label) return label;

  const text = cleanText(fragment || value);
  const volumeMarkers = countMatches(text, /まとめ買い\s*[（(]\s*巻\s*[）)]|シリーズの巻|全\s*[0-9０-９]{1,4}\s*巻/u);
  const episodeMarkers = countMatches(text, /まとめ買い\s*[（(]\s*話\s*[）)]|シリーズの話|全\s*[0-9０-９]{1,4}\s*話|単話|分冊/u);
  if (volumeMarkers > 0 && episodeMarkers === 0) return 'volume';
  if (episodeMarkers > 0 && volumeMarkers === 0) return 'episode';
  if (volumeMarkers > 0 && episodeMarkers > 0) return 'mixed';
  return 'unknown';
}

function lastBulkOfferLabelKind(value) {
  const labels = [...String(value || '').matchAll(/まとめ買い\s*[（(]\s*(話|巻)\s*[）)]/gu)];
  const label = labels.at(-1)?.[1];
  if (label === '巻') return 'volume';
  if (label === '話') return 'episode';
  return '';
}

function countMatches(value, pattern) {
  const regex = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  return [...String(value || '').matchAll(regex)].length;
}

function countPricedItems(items) {
  return items.filter((item) => item.currentPrice != null).length;
}

function mergeBulkSeriesItem(bulkItem, childItem, options = {}) {
  if (!childItem) return bulkItem;
  const merged = {
    ...bulkItem,
    title: preferredSeriesItemTitle(bulkItem, childItem, options),
    imageUrl: childItem.imageUrl || bulkItem.imageUrl || '',
    imageSource: childItem.imageUrl ? childItem.imageSource || 'amazon_series_child' : bulkItem.imageSource || '',
    amazonUrl: childItem.amazonUrl || bulkItem.amazonUrl,
    volume: bulkItem.volume || childItem.volume
  };
  return withPreferredSeriesPricing(merged, childItem, bulkItem);
}

function preferredSeriesItemTitle(primary = {}, secondary = {}, options = {}) {
  const primaryTitle = cleanText(primary.title);
  const secondaryTitle = cleanText(secondary.title);
  if (options.preferChildTitle && secondaryTitle && !/^ASIN\s+[A-Z0-9]{10}$/i.test(secondaryTitle)) {
    return betterText(secondaryTitle, primaryTitle);
  }

  const primaryVolume = Number(primary.volume) || 0;
  const secondaryTitleVolume = extractExternalVolumeFromTitle(secondaryTitle);

  if (
    primaryTitle &&
    !/^ASIN\s+[A-Z0-9]{10}$/i.test(primaryTitle) &&
    primaryVolume > 0 &&
    secondaryTitleVolume > 0 &&
    secondaryTitleVolume !== primaryVolume
  ) {
    return primaryTitle;
  }

  return betterText(secondaryTitle, primaryTitle);
}

function shouldPreferChildSeriesTitles(items = [], childItems = []) {
  if (!items.length || !childItems.length) return false;

  const childByAsin = new Map(childItems.map((item) => [String(item?.asin || '').toUpperCase(), item]));
  const childTitleVolumes = [];
  let mismatches = 0;

  for (const item of items) {
    const asin = String(item?.asin || '').toUpperCase();
    const childItem = childByAsin.get(asin);
    if (!childItem) continue;

    const primaryVolume = Number(item?.volume) || 0;
    const childTitleVolume = Number(extractExternalVolumeFromTitle(childItem.title)) || 0;
    if (!childTitleVolume) continue;

    childTitleVolumes.push(childTitleVolume);
    if (primaryVolume > 0 && childTitleVolume !== primaryVolume) mismatches += 1;
  }

  if (mismatches === 0 || childTitleVolumes.length < 2) return false;
  return new Set(childTitleVolumes).size === childTitleVolumes.length;
}

function withPreferredSeriesPricing(base, primary = {}, fallback = {}) {
  const priced = preferredSeriesPricingSeed(primary, fallback);
  if (!priced) return base;

  const currentPrice = Number(priced.currentPrice);
  if (!Number.isFinite(currentPrice) || currentPrice < 0) return base;

  const currentPoints = sanitizePoints(priced.currentPoints ?? 0, currentPrice);
  const provider = priced.provider || base.provider;
  return {
    ...base,
    currentPrice,
    currentPoints,
    effectivePrice: Math.max(0, Math.round(currentPrice - currentPoints)),
    listPrice: shouldDropSeriesItemListPrice(provider) ? null : priced.listPrice ?? base.listPrice ?? null,
    provider
  };
}

function preferredSeriesPricingSeed(primary = {}, fallback = {}) {
  if (primary.currentPrice == null) return fallback.currentPrice != null ? fallback : null;
  if (fallback.currentPrice == null) return primary;

  const primaryPrice = Number(primary.currentPrice);
  const fallbackPrice = Number(fallback.currentPrice);
  const primaryPoints = Number(primary.currentPoints || 0);
  const fallbackPoints = Number(fallback.currentPoints || 0);
  if (
    Number.isFinite(primaryPrice) &&
    Number.isFinite(fallbackPrice) &&
    primaryPrice === fallbackPrice &&
    primaryPoints <= 0 &&
    fallbackPoints > 0
  ) {
    return fallback;
  }

  return primary;
}

function shouldDropSeriesItemListPrice(provider) {
  const normalized = String(provider || '').toLowerCase();
  return normalized.includes('_series') || normalized === 'amazon_series_bulk' || normalized === 'amazon_series_reader';
}

function extractAsinFromProductHref(fragment) {
  const patterns = [
    /href=["'][^"']*\/gp\/product\/(B[A-Z0-9]{9})[^"']*storeType=ebooks[^"']*["']/i,
    /href=["'][^"']*\/dp\/(B[A-Z0-9]{9})[^"']*storeType=ebooks[^"']*["']/i,
    /href=["'][^"']*\/gp\/product\/(B[A-Z0-9]{9})[^"']*["']/i,
    /href=["'][^"']*\/dp\/(B[A-Z0-9]{9})[^"']*["']/i
  ];
  for (const pattern of patterns) {
    const match = fragment.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return '';
}

function extractChildItemTitle(fragment, asin) {
  const title =
    extractAttribute(fragment, 'title') ||
    extractAttribute(fragment, 'alt') ||
    extractAnchorText(fragment, asin);
  return cleanTitle(title) || `ASIN ${asin}`;
}

function dedupeSeriesItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item.asin)) continue;
    seen.add(item.asin);
    result.push(item);
  }
  return result;
}

function dedupeAsins(asins) {
  const seen = new Set();
  const result = [];
  for (const asin of asins) {
    if (seen.has(asin)) continue;
    seen.add(asin);
    result.push(asin);
  }
  return result;
}

function toFullWidthNumber(value) {
  return String(value).replace(/[0-9]/g, (number) => String.fromCharCode(number.charCodeAt(0) + 0xfee0));
}

function toHalfWidthNumber(value) {
  return String(value).replace(/[０-９，]/g, (char) => {
    if (char === '，') return ',';
    return String.fromCharCode(char.charCodeAt(0) - 0xfee0);
  });
}

function itemFromFragment(asin, fragment) {
  const imageUrl = extractItemImage(fragment);
  return {
    asin,
    title: extractItemTitle(fragment, asin),
    imageUrl,
    imageSource: imageUrl ? 'amazon_series_item' : '',
    amazonUrl: amazonUrlForAsin(asin),
    ...extractSeriesChildItemPricing(fragment)
  };
}

function extractItemFragment(html, index) {
  const safeIndex = Math.max(0, index);
  const divStart = html.lastIndexOf('<div', safeIndex);
  const liStart = html.lastIndexOf('<li', safeIndex);
  const startCandidates = [divStart, liStart].filter((value) => value >= 0);
  const start = startCandidates.length ? Math.max(...startCandidates) : Math.max(0, safeIndex - 500);

  const divEnd = html.indexOf('</div>', safeIndex);
  const liEnd = html.indexOf('</li>', safeIndex);
  const endCandidates = [divEnd >= 0 ? divEnd + 6 : -1, liEnd >= 0 ? liEnd + 5 : -1].filter((value) => value > safeIndex);
  const end = endCandidates.length ? Math.min(...endCandidates) : Math.min(html.length, safeIndex + 1800);

  const fragment = html.slice(start, end);
  if (fragment.length >= 80 && fragment.length <= 6000) return fragment;
  return html.slice(Math.max(0, safeIndex - 600), Math.min(html.length, safeIndex + 1800));
}

function mergeSeriesItem(a, b) {
  if (!a) return b;
  const merged = {
    asin: a.asin || b.asin,
    title: betterText(a.title, b.title),
    imageUrl: a.imageUrl || b.imageUrl || '',
    imageSource: a.imageUrl ? a.imageSource || '' : b.imageSource || '',
    amazonUrl: a.amazonUrl || b.amazonUrl,
    volume: a.volume || b.volume
  };
  return withPreferredSeriesPricing(merged, a, b);
}

function betterText(a, b) {
  const left = cleanText(a);
  const right = cleanText(b);
  if (!left) return right;
  if (!right) return left;
  if (/^ASIN\s+[A-Z0-9]{10}$/i.test(left)) return right;
  return left.length >= right.length ? left : right;
}

function extractItemTitle(fragment, asin) {
  const candidates = [
    extractAttribute(fragment, 'alt'),
    extractAttribute(fragment, 'title'),
    extractAttribute(fragment, 'aria-label'),
    extractAnchorText(fragment, asin)
  ]
    .map(cleanTitle)
    .filter(Boolean)
    .filter((title) => !/^https?:\/\//i.test(title))
    .filter((title) => !title.includes('Amazon.co.jp'));

  return candidates.sort((a, b) => b.length - a.length)[0] || `ASIN ${asin}`;
}

function extractItemImage(fragment) {
  const candidates = [];
  const dynamic = fragment.match(/\bdata-a-dynamic-image=["']([^"']+)["']/i);
  if (dynamic) {
    const decoded = decodeHtml(dynamic[1]);
    for (const match of decoded.matchAll(/https?:\/\/[^"']+?(?:\.jpg|\.jpeg|\.png|\.webp)/gi)) {
      candidates.push(match[0]);
    }
  }

  const attrs = ['data-src', 'data-old-hires', 'data-a-hires', 'src'];
  for (const attr of attrs) {
    const value = extractAttribute(fragment, attr);
    if (isAmazonImage(value)) candidates.push(value);
  }

  for (const srcset of extractAttributes(fragment, 'srcset')) {
    for (const match of srcset.matchAll(/https?:\/\/[^,\s]+?(?:\.jpg|\.jpeg|\.png|\.webp)/gi)) {
      candidates.push(match[0]);
    }
  }

  for (const match of fragment.matchAll(/https?:\/\/[^"'\s<>]+?(?:\.jpg|\.jpeg|\.png|\.webp)/gi)) {
    candidates.push(match[0]);
  }

  return bestItemImage(candidates);
}

function bestItemImage(candidates = []) {
  const seen = new Set();
  const normalized = [];

  for (const candidate of candidates) {
    const imageUrl = decodeHtml(String(candidate || '').trim());
    if (!isAmazonImage(imageUrl) || seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    normalized.push(imageUrl);
  }

  return normalized.find((url) => !isKnownWeakAmazonImageUrl(url)) || '';
}

function extractAttribute(fragment, attr) {
  const pattern = new RegExp(`\\b${escapeRegExp(attr)}=["']([^"']+)["']`, 'i');
  const match = fragment.match(pattern);
  return match ? decodeHtml(match[1]) : '';
}

function extractAttributes(fragment, attr) {
  const pattern = new RegExp(`\\b${escapeRegExp(attr)}=["']([^"']+)["']`, 'gi');
  return [...String(fragment || '').matchAll(pattern)].map((match) => decodeHtml(match[1]));
}

function extractAnchorText(fragment, asin) {
  const pattern = new RegExp(`<a\\b[^>]+href=["'][^"']*${asin}[^"']*["'][^>]*>([\\s\\S]*?)<\\/a>`, 'i');
  const match = fragment.match(pattern);
  return match ? cleanText(match[1]) : '';
}

function extractSeriesChildItemPricing(fragment) {
  const price = extractSeriesChildItemPrice(fragment);
  if (price == null) return {};

  const points = extractSeriesChildItemPoints(fragment, price);
  return {
    currentPrice: price,
    currentPoints: points,
    effectivePrice: Math.max(0, Math.round(price - points)),
    provider: 'amazon_series_child'
  };
}

function extractSeriesChildItemPrice(fragment) {
  const value = String(fragment || '');
  const scopes = [
    ...[...value.matchAll(/<span\b[^>]*class=["'][^"']*\ba-color-price\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map((match) => match[1]),
    ...[...value.matchAll(/<span\b[^>]*class=["'][^"']*\ba-price\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map((match) => match[1])
  ];

  for (const scope of scopes) {
    const text = cleanText(scope);
    if (!/(?:￥|¥|円)/.test(text)) continue;
    const price = parsePrice(text);
    if (price != null) return price;
  }

  return null;
}

function extractSeriesChildItemPoints(fragment, currentPrice) {
  const value = String(fragment || '');
  const scopes = [
    ...[...value.matchAll(/<span\b[^>]*class=["'][^"']*\bitemPoints\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map((match) => match[1]),
    ...[...value.matchAll(/獲得ポイント\s*:?\s*<\/?[^>]*>\s*([0-9０-９,，]+)\s*pt/gi)].map((match) => match[1])
  ];

  for (const scope of scopes) {
    const points = parseOptionalPoints(scope);
    if (points != null && points <= currentPrice) return points;
  }

  return 0;
}

function extractSeriesName(html) {
  return cleanAmazonSeriesName(
    extractById(html, 'collectionTitle') ||
      extractById(html, 'series-title') ||
      extractById(html, 'ebooksProductTitle') ||
      extractMeta(html, 'og:title') ||
      extractTag(html, 'title')
  );
}

function extractSeriesExpectedCount(html) {
  const scopes = [
    extractById(html, 'collectionTitle'),
    extractById(html, 'series-title'),
    extractById(html, 'ebooksProductTitle'),
    extractMeta(html, 'og:title'),
    extractTag(html, 'title'),
    extractTag(html, 'h1')
  ].filter(Boolean);

  for (const scope of scopes) {
    const count = extractVolumeCount(scope);
    if (count) return count;
  }
  return 0;
}

export function extractSeriesCompletionStatusFromHtml(html) {
  return extractSeriesCompletionStatus(html);
}

function extractSeriesCompletionStatus(html) {
  const scopes = [
    extractById(html, 'collectionTitle'),
    extractById(html, 'series-title'),
    extractById(html, 'ebooksProductTitle'),
    extractMeta(html, 'description'),
    extractMeta(html, 'og:title'),
    extractTag(html, 'title'),
    extractTag(html, 'h1'),
    ...completionEvidenceScopes(html)
  ];

  return scopes.some((scope) => hasSeriesCompletionEvidence(scope));
}

export function extractMangaZenkanCompletionEvidenceFromHtml(html, seriesName = '', expectedVolumeCount = 0) {
  return extractMangaZenkanCompletionEvidence(html, seriesName, expectedVolumeCount);
}

function extractMangaZenkanCompletionEvidence(html, seriesName = '', expectedVolumeCount = 0) {
  const normalizedSeriesName = normalizeSeriesNameForMatch(seriesName);
  const expected = Number(expectedVolumeCount) || 0;
  if (!normalizedSeriesName || expected <= 1) return null;

  const candidates = mangaZenkanCompletionCandidateScopes(html);
  for (const scope of candidates) {
    const text = pageEvidenceText(scope);
    if (!text || !normalizeSeriesNameForMatch(text).includes(normalizedSeriesName)) continue;

    const count = extractVolumeCount(text) || mangaZenkanAllVolumeCount(text);
    if (count && count !== expected) continue;
    if (hasMangaZenkanOngoingMarker(text)) continue;
    if (hasSeriesCompletionNegation(text)) continue;

    if (hasSeriesCompletionEvidence(text) || /タグ\s*完結|tags\s*:\s*["']完結["']/.test(text)) {
      return {
        completed: true,
        source: 'mangazenkan_search'
      };
    }

    if (hasMangaZenkanAllVolumeCompletionEvidence(text, expected)) {
      return {
        completed: true,
        source: 'mangazenkan_all_volume'
      };
    }
  }

  return null;
}

function hasMangaZenkanOngoingMarker(scope) {
  const value = pageEvidenceText(scope);
  return /(?:最新刊|続刊|連載中|未完結)/.test(value);
}

function hasMangaZenkanAllVolumeCompletionEvidence(scope, expectedVolumeCount = 0) {
  const expected = Number(expectedVolumeCount) || 0;
  if (expected <= 1) return false;
  const count = mangaZenkanAllVolumeCount(scope);
  return count > 1 && count === expected;
}

function completionEvidenceScopes(html) {
  const value = String(html || '');
  const scopes = [];
  for (const id of [
    'productDescription',
    'bookDescription_feature_div',
    'editorialReviews_feature_div',
    'aplus_feature_div',
    'feature-bullets'
  ]) {
    const text = extractById(value, id);
    if (text) scopes.push(text);
  }
  for (const match of value.matchAll(/productDescription|bookDescription|editorialReviews|内容紹介|商品の説明|出版社より|著者について/gi)) {
    const fragment = value.slice(Math.max(0, (match.index || 0) - 400), Math.min(value.length, (match.index || 0) + 2600));
    if (fragment) scopes.push(fragment);
  }
  return scopes;
}

function hasSeriesCompletionEvidence(scope) {
  const value = pageEvidenceText(scope);
  if (!value) return false;
  if (hasSeriesCompletionNegation(value)) return false;

  const compact = value.replace(/\s+/g, '');
  return (
    /(?:全\s*)?[0-9０-９]{1,3}\s*巻\s*(?:完結|完)/.test(value) ||
    /(?:完結済み|完結作品|シリーズ完結|全巻完結|完結巻|最終巻|最終回)/.test(value) ||
    /(?:遂に|ついに|遂げに|堂々|ここに|いよいよ|ついに、?|遂に、?).{0,16}完結/.test(value) ||
    /(?:完結|最終巻).{0,16}(?:!!|！|。|$)/.test(compact) ||
    /\b(?:completed|complete)\s+series\b/i.test(value)
  );
}

function hasSeriesCompletionNegation(scope) {
  const value = pageEvidenceText(scope);
  return (
    /(?:未完結|完結していない|完結ではない|完結予定|完結間近|完結へ|最終回から|復活連載|連載再開)/.test(value) ||
    /(?:次(?:巻|号|回|刊|作)|次の(?:巻|号|回|刊|作品)|続巻).{0,32}(?:完結|最終巻|最終回)/.test(value) ||
    /(?:完結|最終巻|最終回).{0,32}(?:次(?:巻|号|回|刊|作)|次の(?:巻|号|回|刊|作品)|続巻)/.test(value) ||
    /(?:第\s*)?[一二三四五六七八九十0-9０-９]+\s*部.{0,32}完結/.test(value)
  );
}

function completionKeywordScopes(html) {
  const text = pageEvidenceText(html);
  if (!text) return [];

  const scopes = [];
  const pattern = /(?:遂に|ついに|堂々|ここに|いよいよ).{0,16}完結|完結!!|完結！|完結。|最終巻|最終回/g;
  for (const match of text.matchAll(pattern)) {
    const index = match.index || 0;
    scopes.push(text.slice(Math.max(0, index - 160), Math.min(text.length, index + 220)));
    if (scopes.length >= 4) break;
  }
  return scopes;
}

function mangaZenkanCompletionCandidateScopes(html) {
  const value = String(html || '');
  const scopes = [];

  for (const match of value.matchAll(/<div\b[^>]*class=["'][^"']*search-result-item[^"']*["'][\s\S]*?(?=<div\b[^>]*class=["'][^"']*search-result-item|<\/script>|$)/gi)) {
    scopes.push(match[0]);
  }

  for (const match of value.matchAll(/\{product_id:[\s\S]{0,3500}?tags:[\s\S]{0,120}?(?:完結|未設定)[\s\S]{0,1200}?\}/g)) {
    scopes.push(match[0]);
  }

  for (const match of value.matchAll(/[^\n。]{0,240}(?:[0-9０-９]+\s*-\s*[0-9０-９]+\s*巻\s*全巻|全\s*[0-9０-９]+\s*巻|タグ\s*完結|tags\s*:\s*["']完結["'])[^\n。]{0,600}/g)) {
    scopes.push(match[0]);
  }

  return scopes.length ? scopes : completionKeywordScopes(value);
}

function mangaZenkanAllVolumeCount(text) {
  const value = String(text || '');
  const range = value.match(/(?:[（(]?\s*)?1\s*-\s*([0-9０-９]{1,3})\s*巻\s*全巻/);
  if (range) return Number(toHalfWidthNumber(range[1])) || 0;

  const set = value.match(/([0-9０-９]{1,3})\s*冊\s*セット\s*全巻/);
  if (set) return Number(toHalfWidthNumber(set[1])) || 0;

  return 0;
}

function extractVolumeCount(text) {
  const counts = [...String(text || '').matchAll(/全\s*([0-9０-９]{1,3})\s*巻/g)]
    .map((match) => Number(toHalfWidthNumber(match[1])))
    .filter((value) => Number.isFinite(value) && value > 0);
  return counts.length ? Math.max(...counts) : 0;
}

function maxSeriesItemVolume(items) {
  const volumes = items
    .map((item) => Number(item.volume) || Number(toHalfWidthNumber(String(item.title || '').match(/(?:第)?([0-9０-９]{1,3})\s*巻/)?.[1] || '')))
    .filter((value) => Number.isFinite(value) && value > 0);
  return volumes.length ? Math.max(...volumes) : 0;
}

function cleanTitle(value) {
  return cleanText(value)
    .replace(/\s+\|.*$/, '')
    .replace(/\s*-\s*Amazon.*$/i, '')
    .replace(/\s*\(Kindle版\)\s*$/, '')
    .trim();
}

export function cleanAmazonSeriesName(value) {
  let text = cleanTitle(value);
  for (let index = 0; index < 4; index += 1) {
    const next = cleanupSeriesNameSeparators(
      stripSeriesVolumeTokens(
        stripSeriesImprint(
          text
            .replace(/^Amazon\.co\.jp\s*[:：]\s*/i, '')
            .replace(/\s+(?:eBook|電子書籍)\s*[:：].*$/i, '')
            .replace(/\s*[:：]\s*Kindle(?:ストア| Store).*$/i, '')
            .replace(/\s+Kindle(?:ストア| Store).*$/i, '')
            .replace(/\s*Kindle版.*$/i, '')
            .replace(/\s*\(全\s*[0-9０-９]+\s*巻\).*$/i, '')
            .replace(/\s*全\s*[0-9０-９]+\s*巻.*$/i, '')
        )
      )
    );
    if (next === text) break;
    text = next;
  }
  return text || 'Kindle シリーズ';
}

function stripSeriesImprint(value) {
  return String(value || '')
    .replace(/\s*[（(][^（）()]{0,100}(?:コミックス|コミック|文庫|新書|DX|KC|REX|ZERO-SUM|モーニング|イブニング|アフタヌーン|ビッグ|スピリッツ|ジャンプ|マガジン|サンデー|チャンピオン|ヒーローズ|A\.?L\.?C\.?|L\.?C\.?|ebook|Kindle|DIGITAL|デジタル|TC|ビーム)[^（）()]{0,100}[）)]\s*/giu, ' ');
}

function stripSeriesVolumeTokens(value) {
  return String(value || '')
    .replace(/\s*[（(]\s*(?:第\s*)?[0-9０-９]{1,4}\s*(?:巻|巻目)?\s*[）)]\s*/giu, ' ')
    .replace(/\s*[（(]\s*(?:上|中|下|前編|後編|完結編)\s*[）)]\s*/gu, ' ')
    .replace(/(^|[\s　\-－–—:：])(?:第\s*)?[0-9０-９]{1,4}\s*巻(?=$|[\s　\-－–—:：])/giu, '$1 ')
    .replace(/(^|[\s　\-－–—:：])(?:上|中|下|前編|後編|完結編)(?=$|[\s　\-－–—:：])/gu, '$1 ')
    .replace(/(^|[\s　\-－–—:：])(?:vol\.?|volume)\s*[0-9０-９]{1,4}(?=$|[\s　\-－–—:：])/giu, '$1 ')
    .replace(/(^|[\s　\-－–—:：])(?:第\s*)?[0-9０-９]{1,4}(?=$|[\s　\-－–—:：])/giu, '$1 ');
}

function cleanupSeriesNameSeparators(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-－–—:：]\s*$/u, '')
    .replace(/^\s*[-－–—:：]\s*/u, '')
    .trim();
}

function isAmazonImage(value) {
  return Boolean(value && /m\.media-amazon\.com|images-(?:fe|na)\.ssl-images-amazon\.com|\.media-amazon\./i.test(value));
}

function isKnownWeakAmazonImageUrl(value) {
  const normalized = String(value || '').toLowerCase();
  return (
    /\/a19vjrnyppl\./.test(normalized) ||
    /(?:no[_-]?image|not[_-]?available|placeholder|transparent|pixel|sprite)/.test(normalized)
  );
}

export function isProbablyBookAsin(asin) {
  return /^B[A-Z0-9]{9}$/.test(asin);
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function readNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

function nullableNumber(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function extractById(html, id) {
  const pattern = new RegExp(`<[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
  return decodeHtml(html.match(pattern)?.[1] || '');
}

function extractMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escapeRegExp(property)}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRegExp(property)}["'][^>]*>`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return '';
}

function extractTag(html, tag) {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeHtml(match[1]) : '';
}

function extractContributor(html) {
  const contributors = [];
  const contributorPattern = /<span[^>]+class=["'][^"']*author[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
  for (const match of html.matchAll(contributorPattern)) {
    const text = cleanText(match[1]);
    if (text && !contributors.includes(text)) contributors.push(text);
  }
  return contributors.slice(0, 3).join(', ');
}

function extractDetail(html, labelPattern) {
  const listPattern = /<li[^>]*>\s*<span[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/li>/gi;
  for (const match of html.matchAll(listPattern)) {
    if (labelPattern.test(cleanText(match[1]))) return cleanText(match[2]);
  }
  return '';
}

function extractAmazonReleaseDate(html) {
  const detail = cleanMetadataText(extractDetail(html, /発売日|配信日|Publication date/i));
  const normalizedDetail = normalizeReleaseDate(detail);
  if (normalizedDetail) return normalizedDetail;

  const text = releaseDateText(String(html || '').slice(0, 300000));
  const autoDelivery = text.match(/([12][0-9]{3}\s*(?:\/|年|-)\s*[0-9]{1,2}\s*(?:\/|月|-)\s*[0-9]{1,2})\s*(?:日)?\s*に、?\s*Kindleに自動配信/);
  const normalizedAutoDelivery = normalizeReleaseDate(autoDelivery?.[1] || '');
  if (normalizedAutoDelivery) return normalizedAutoDelivery;

  const labelMatch = text.match(/(?:発売日|配信日|Publication date)\s*[:：]?\s*([12][0-9]{3}\s*(?:\/|年|-)\s*[0-9]{1,2}\s*(?:\/|月|-)\s*[0-9]{1,2})/i);
  return normalizeReleaseDate(labelMatch?.[1] || '');
}

function releaseDateText(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLandingImage(html) {
  const match = html.match(/data-old-hires=["']([^"']+)["']/i) || html.match(/landingImage["'][^>]+src=["']([^"']+)["']/i);
  return match ? decodeHtml(match[1]) : '';
}

function extractPrices(html) {
  const prices = new Set();
  const value = decodeJsonEscapes(decodeHtml(html));
  const pricePatterns = [
    { pattern: /(?:￥|¥)\s*([0-9][0-9,]*)/g, contextual: true },
    { pattern: /<span[^>]+class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([0-9,]+)\s*<\/span>/gi, contextual: false },
    { pattern: /["'](?:displayPrice|priceString|formattedPrice|buyingPrice)["']\s*:\s*["'][^"']*(?:￥|¥|JPY)\s*([0-9][0-9,]*)/gi, contextual: false }
  ];

  for (const { pattern, contextual } of pricePatterns) {
    for (const match of value.matchAll(pattern)) {
      if (contextual && !isLikelyPriceContext(value, match.index ?? 0, 160)) continue;
      if (isIgnoredKindlePriceContext(value, match.index ?? 0)) continue;
      if (isStruckListPriceContext(value, match.index ?? 0)) continue;
      const price = parsePrice(match[1]);
      if (price != null) prices.add(price);
    }
  }

  for (const candidate of extractAOffscreenPriceCandidates(value)) prices.add(candidate.price);
  for (const price of extractContextualJpyPrices(value)) prices.add(price);
  for (const price of extractStructuredJpyPrices(value)) prices.add(price);

  return [...prices].filter((price) => price >= 0).sort((a, b) => a - b);
}

function extractContextualJpyPrices(value) {
  const prices = [];
  const text = String(value || '');
  for (const match of text.matchAll(/\bJPY\s*([0-9][0-9,]*)/gi)) {
    if (!isLikelyPriceContext(text, match.index ?? 0, 120)) continue;
    const price = parsePrice(match[1]);
    if (price != null) prices.push(price);
  }
  return prices;
}

function extractStructuredJpyPrices(value) {
  const prices = [];
  const text = String(value || '');
  const amountKeys = '(?:priceAmount|amountToPay|displayedPrice\\.value|buyingPrice|salePrice|ourPrice|listPrice|basisPrice|currentPrice|price)';
  const currencyKeys = '(?:currencyCode|currency)';
  const patterns = [
    new RegExp(`["']${amountKeys}["']\\s*:\\s*["']?([0-9][0-9,]{1,8})(?:\\.0+)?["']?[\\s\\S]{0,160}?["']${currencyKeys}["']\\s*:\\s*["']JPY["']`, 'gi'),
    new RegExp(`["']${currencyKeys}["']\\s*:\\s*["']JPY["'][\\s\\S]{0,160}?["']${amountKeys}["']\\s*:\\s*["']?([0-9][0-9,]{1,8})(?:\\.0+)?["']?`, 'gi')
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const price = parsePrice(match[1]);
      if (price != null) prices.push(price);
    }
  }

  const genericPatterns = [
    new RegExp(`["'](?:amount|value)["']\\s*:\\s*["']?([0-9][0-9,]{1,8})(?:\\.0+)?["']?[\\s\\S]{0,160}?["']${currencyKeys}["']\\s*:\\s*["']JPY["']`, 'gi'),
    new RegExp(`["']${currencyKeys}["']\\s*:\\s*["']JPY["'][\\s\\S]{0,160}?["'](?:amount|value)["']\\s*:\\s*["']?([0-9][0-9,]{1,8})(?:\\.0+)?["']?`, 'gi')
  ];

  for (const pattern of genericPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (!isLikelyPriceContext(text, match.index ?? 0, 260)) continue;
      const price = parsePrice(match[1]);
      if (price != null) prices.push(price);
    }
  }

  return prices;
}

function chooseLikelyKindlePrice(prices, html = '') {
  if (!prices.length) return null;
  const explicitPrices = extractExplicitKindlePriceCandidates(html);
  const explicitWithPoints = explicitPrices.find((price) => extractPointsNearPrice(html, price) != null);
  if (explicitWithPoints != null) return explicitWithPoints;
  if (explicitPrices.length) return explicitPrices[0];

  const priceWithPoints = prices.find((price) => extractPointsNearPrice(html, price) != null);
  if (priceWithPoints != null) return priceWithPoints;
  const explicitlyDisplayed = prices.find((price) => hasExplicitPriceDisplay(html, price));
  if (explicitlyDisplayed != null) return explicitlyDisplayed;
  const positivePrices = prices.filter((price) => price > 0);
  const fallback = positivePrices[0] ?? (hasExplicitFreeKindlePrice(html) && prices.includes(0) ? 0 : null);
  if (isAmbiguousTinyFallbackPrice(fallback, prices, html)) return null;
  return fallback;
}

function extractExplicitKindlePriceCandidates(html) {
  for (const scopes of priceEvidenceScopeGroups(html)) {
    const candidates = new Set();
    for (const scope of scopes) {
      addExplicitKindlePriceCandidates(candidates, scope);
    }
    if (candidates.size > 0) return [...candidates].sort((a, b) => a - b);
  }

  return [];
}

function addExplicitKindlePriceCandidates(candidates, scope) {
  const value = decodeJsonEscapes(decodeHtml(scope));
  for (const candidate of extractAOffscreenPriceCandidates(value)) {
    candidates.add(candidate.price);
  }

  const patterns = [
    /(?:￥|¥)\s*([0-9][0-9,]*)/g,
    /([0-9][0-9,]*)\s*円/g,
    /\bJPY\s*([0-9][0-9,]*)/gi,
    /<span[^>]+class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([0-9,]+)\s*<\/span>/gi
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      if (isIgnoredKindlePriceContext(value, match.index ?? 0)) continue;
      if (isDiscountContextAround(value, match.index ?? 0) && !isDirectPurchasePriceContext(value, match.index ?? 0)) {
        continue;
      }
      const price = parsePrice(match[1]);
      if (price != null) candidates.add(price);
    }
  }
}

function extractAOffscreenPriceCandidates(html) {
  const candidates = [];
  const value = String(html || '');
  const pattern = /<span\b[^>]*class=["'][^"']*\ba-offscreen\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;

  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    const context = value.slice(Math.max(0, index - 700), Math.min(value.length, index + 700));
    if (isStruckListPriceContext(value, index)) continue;
    if (isIgnoredKindlePriceContext(value, index)) continue;
    if (!isLikelyPriceContext(value, index, 220) && !/a-price|data-a-color=["']price|priceToPay|corePrice|apex|kindle/i.test(context)) {
      continue;
    }

    const text = cleanText(match[1]);
    if (isDiscountOrRewardContext(text)) continue;
    const price = parsePrice(text);
    if (price != null) candidates.push({ price, index });
  }

  return candidates;
}

function isLikelyPriceContext(text, index, radius = 180) {
  const context = String(text || '').slice(Math.max(0, index - radius), index + radius);
  if (isDiscountContext(context)) return false;
  return /price|Price|価格|値段|金額|amountToPay|displayPrice|displayedPrice|buyingPrice|priceToPay|salePrice|ourPrice|listPrice|basisPrice|currentPrice|a-price|ebook-price-value|CoP-ActualPrice/i.test(context);
}

function isDiscountOrRewardContext(context) {
  return /discount|percentage|percent|saving|savings|coupon|promotion|promo|points?|reward|割引|値引|還元|ポイント|%|％/i.test(
    String(context || '')
  );
}

function isDiscountContext(context) {
  return /discount|percentage|percent|saving|savings|coupon|promotion|promo|割引|値引|%|％/i.test(String(context || ''));
}

function isDiscountContextAround(text, index, radius = 140) {
  const value = String(text || '');
  return isDiscountContext(value.slice(Math.max(0, index - radius), Math.min(value.length, index + radius)));
}

function isDirectPurchasePriceContext(text, index, radius = 80) {
  const value = cleanText(String(text || '').slice(Math.max(0, index - radius), Math.min(String(text || '').length, index + radius)))
    .replace(/\s+/g, '');
  return /(?:￥|¥)?[0-9,]+(?:円)?(?:\([0-9,]+pt\)|（[0-9,]+pt）|[0-9,]+ポイント)?で購入/i.test(value);
}

function hasExplicitFreeKindlePrice(html) {
  const text = cleanText(decodeJsonEscapes(decodeHtml(html))).replace(/\s+/g, '');
  if (!text) return false;
  return (
    /(?:Kindle価格|価格|現在価格|販売価格)[:：]?(?:￥|¥)?0円?/.test(text) ||
    /(?:Kindle価格|価格|現在価格|販売価格)[:：]?無料/.test(text) ||
    /(?:￥|¥)\s*0(?![0-9,])/.test(text) ||
    /無料で購入/.test(text)
  );
}

function isAmbiguousTinyFallbackPrice(price, prices = [], html = '') {
  const current = Number(price);
  if (!Number.isFinite(current) || current > IMPLICIT_TINY_KINDLE_PRICE_MAX) return false;
  if (hasExplicitPriceDisplay(html, current) || hasExplicitFreeKindlePrice(html)) return false;
  return prices.some((candidate) => Number(candidate) >= 100);
}

function isIgnoredKindlePriceContext(text, index) {
  if (isStruckListPriceContext(text, index)) return true;
  const near = cleanText(String(text || '').slice(Math.max(0, index - 80), Math.min(String(text || '').length, index + 100)));
  const compactNear = near.replace(/\s+/g, '');
  if (/(?:その他)?(?:中古品?|新品|コレクター商品|マーケットプレイス).{0,24}(?:￥|¥|[0-9,]+円|から)|(?:￥|¥|[0-9,]+円).{0,24}(?:中古品?|新品|コレクター商品|マーケットプレイス)|used|collectible|marketplace/i.test(compactNear)) {
    return true;
  }
  if (/(?:獲得)?ポイント|points?|pt/i.test(near) && !/(?:￥|¥|円|\bJPY\b)/i.test(near)) {
    return true;
  }
  if (/コミック[（(]\s*紙\s*[）)]|文庫[（(]\s*紙\s*[）)]|紙(?:の)?(?:本|書籍|版)|Paperback|paperback|Tankobon|単行本/i.test(near)) {
    return true;
  }

  return false;
}

function isStruckListPriceContext(text, index, radius = 260) {
  const context = String(text || '').slice(Math.max(0, index - radius), index + 80);
  return /a-text-price|basisPrice|listPrice|wasPrice|savingsBasis|参考価格|通常価格|過去価格|定価/i.test(context);
}

function correctImplausibleKindlePrice({ currentPrice, currentPoints, listPrice, prices, html }) {
  if (isSuspiciousAboveListPrice(currentPrice, listPrice)) {
    return { currentPrice: null, currentPoints: 0 };
  }

  const explicitReplacement = explicitDisplayedPriceForTinyContamination(currentPrice, currentPoints, html);
  if (explicitReplacement != null) {
    return {
      currentPrice: explicitReplacement,
      currentPoints: sanitizePoints(extractPointsNearPrice(html, explicitReplacement) ?? 0, explicitReplacement)
    };
  }

  if (isImplicitTinyOrFreeKindlePrice(currentPrice, html)) {
    return { currentPrice: null, currentPoints: 0 };
  }

  const inferred = inferDiscountedKindlePrice(html, listPrice);
  if (isLikelyPercentContaminatedKindlePrice({ currentPrice, currentPoints, listPrice, html })) {
    return {
      currentPrice: inferred,
      currentPoints: inferred == null ? 0 : sanitizePoints(extractPointsNearPrice(html, inferred) ?? 0, inferred)
    };
  }

  if (
    currentPrice != null &&
    inferred != null &&
    inferred !== currentPrice &&
    !hasExplicitPriceDisplay(html, currentPrice) &&
    (isDiscountPercentValue(html, currentPrice) || isSuspiciousDiscountLikePrice(currentPrice, currentPoints, listPrice, prices))
  ) {
    return {
      currentPrice: inferred,
      currentPoints: sanitizePoints(extractPointsNearPrice(html, inferred) ?? 0, inferred)
    };
  }

  return {
    currentPrice,
    currentPoints: sanitizePoints(currentPoints, currentPrice)
  };
}

function isImplicitTinyOrFreeKindlePrice(currentPrice, html = '') {
  const current = Number(currentPrice);
  if (!Number.isFinite(current) || current < 0 || current > IMPLICIT_TINY_KINDLE_PRICE_MAX) return false;
  if (hasExplicitPriceDisplay(html, current) || hasExplicitFreeKindlePrice(html)) return false;
  return true;
}

function inferDiscountedKindlePrice(html, listPrice) {
  if (!Number.isFinite(listPrice) || listPrice <= 0) return null;

  for (const scope of discountInferenceScopes(html, listPrice)) {
    const percent = extractDiscountPercent(scope);
    if (percent == null || percent <= 0 || percent >= 100) continue;

    const inferred = Math.round((listPrice * (100 - percent)) / 100);
    if (inferred >= 0 && inferred < listPrice) return inferred;
  }

  return null;
}

function shouldPreferInferredDiscountPrice({ currentPrice, inferredPrice, listPrice, html, explicitOffer = false }) {
  if (inferredPrice == null || explicitOffer) return false;
  if (!Number.isFinite(Number(listPrice)) || Number(listPrice) <= 0) return false;
  if (hasExplicitPriceDisplay(html, inferredPrice)) return true;
  if (currentPrice == null) return false;
  if (hasExplicitPriceDisplay(html, currentPrice) && Number(currentPrice) < Number(listPrice)) return false;
  return isDiscountPercentValue(html, currentPrice) && !hasExplicitPriceDisplay(html, currentPrice);
}

function isExplicitKindleOffer(offer = {}) {
  return ['purchase_text', 'bifrost'].includes(String(offer.source || ''));
}

function discountInferenceScopes(html, listPrice) {
  const value = String(html || '');
  return [
    extractKindleSwatch(value),
    extractFragmentAroundPattern(value, /ebook-price-value|priceToPay|kindleExtraMessage|oneClick|one-click|buybox/i, 2000, 5000),
    extractFragmentAroundPrice(value, listPrice)
  ].filter(Boolean);
}

function extractFragmentAroundPrice(html, price) {
  if (!Number.isFinite(price)) return '';
  const value = String(html || '');
  const pattern = new RegExp(`(?:￥|¥)\\s*${yenAmountPatternForPrice(price)}`);
  return extractFragmentAroundPattern(value, pattern, 2200, 4200);
}

function extractDiscountPercent(html) {
  const text = cleanText(decodeJsonEscapes(html)).replace(/\s+/g, '');
  const patterns = [
    /([0-9]{1,2})\s*(?:パーセント|%)の?割引/,
    /([0-9]{1,2})\s*%OFF/i,
    /([0-9]{1,2})\s*%オフ/i,
    /(?:割引率|値引率|discount)\s*[:：]?\s*([0-9]{1,2})\s*%/i
  ];

  for (const pattern of patterns) {
    const percent = Number.parseInt(text.match(pattern)?.[1] || '', 10);
    if (Number.isFinite(percent)) return percent;
  }

  return null;
}

function hasExplicitPriceDisplay(html, price) {
  if (price == null || !Number.isFinite(Number(price))) return false;
  const amount = yenAmountPatternForPrice(price);
  const pattern = new RegExp(`(?:(?:￥|¥|JPY)\\s*${amount}|${amount}\\s*円)(?!\\s*(?:%|％))`, 'gi');
  return priceEvidenceScopes(html).some((scope) => {
    const value = decodeJsonEscapes(decodeHtml(scope));
    for (const match of value.matchAll(pattern)) {
      if (!isIgnoredKindlePriceContext(value, match.index ?? 0)) return true;
    }
    return false;
  });
}

function explicitDisplayedPriceForTinyContamination(currentPrice, currentPoints, html = '') {
  const current = Number(currentPrice);
  if (!Number.isFinite(current) || current > IMPLICIT_TINY_KINDLE_PRICE_MAX) return null;
  if (hasExplicitPriceDisplay(html, current) || hasExplicitFreeKindlePrice(html)) return null;

  const pointValue = Number(currentPoints || 0);
  if (current > 0 && (!Number.isFinite(pointValue) || pointValue < current)) return null;

  return extractExplicitKindlePriceCandidates(html)
    .filter((price) => price >= 100 && price !== current && hasExplicitPriceDisplay(html, price))
    .sort((a, b) => a - b)[0] ?? null;
}

function priceEvidenceScopes(html) {
  return priceEvidenceScopeGroups(html).flat();
}

function priceEvidenceScopeGroups(html) {
  const value = String(html || '');
  return [
    [extractKindleSwatch(value)].filter(Boolean),
    [
      extractFragmentAroundPattern(
        value,
        /Kindle版|電子書籍|ebook-price-value|priceToPay|kindleExtraMessage|oneClick|one-click|buybox|CoP-ActualPrice/i,
        2200,
        5200
      )
    ].filter(Boolean),
    [value.length <= 20000 ? value : ''].filter(Boolean)
  ].filter((group) => group.length > 0);
}

function isDiscountPercentValue(html, value) {
  if (value == null || !Number.isFinite(Number(value))) return false;
  const percent = Math.round(Number(value));
  if (percent <= 0 || percent >= 100) return false;
  const text = cleanText(decodeJsonEscapes(html)).replace(/\s+/g, '');
  const escaped = escapeRegExp(String(percent));
  return new RegExp(`(?:-|−)?${escaped}(?:パーセント|%)|${escaped}(?:パーセント|%)OFF|${escaped}(?:パーセント|%)オフ`, 'i').test(text);
}

function sanitizePoints(points, currentPrice) {
  const pointValue = Number(points || 0);
  const price = Number(currentPrice);
  if (!Number.isFinite(pointValue) || pointValue < 0) return 0;
  if (Number.isFinite(price) && price >= 0 && pointValue > price) return 0;
  return Math.round(pointValue);
}

function isSuspiciousDiscountLikePrice(currentPrice, currentPoints, listPrice, prices = []) {
  if (currentPrice == null || currentPrice <= 0) return false;
  if (!currentPoints || currentPoints / currentPrice < 0.5) return false;
  const maxPrice = Math.max(listPrice || 0, ...prices);
  if (!maxPrice || maxPrice < currentPrice * 4) return false;
  return !listPrice || currentPrice <= listPrice * 0.3;
}

function isSuspiciousAboveListPrice(currentPrice, listPrice) {
  return currentPrice != null && listPrice != null && currentPrice > listPrice * 1.15;
}

function isLikelyPercentContaminatedKindlePrice({ currentPrice, currentPoints, listPrice, html }) {
  const price = Number(currentPrice);
  const points = Number(currentPoints || 0);
  const list = Number(listPrice);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(points) || points <= 0) return false;
  if (hasExplicitPriceDisplay(html, price)) return false;

  const pointRatio = points / price;
  const priceLooksLikeDiscountPercent = isDiscountPercentValue(html, price);
  const deepDiscountAgainstList =
    Number.isFinite(list) && list >= 1000 && price <= 100 && price <= list * 0.05 && pointRatio >= 0.2;

  return priceLooksLikeDiscountPercent && deepDiscountAgainstList;
}

function extractBulkOfferUnitPrice(html, expectedCount = 0) {
  const candidates = new Map();

  for (const match of String(html || '').matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
    const fragment = match[0];
    const count = countBulkOfferAsins(fragment);
    if (count > 1) addBulkOfferUnitPriceCandidates(candidates, count, extractPrices(fragment));
  }

  if (candidates.size === 0) {
    for (const match of String(html || '').matchAll(/\bdata-offer-asins=["']([^"']+)["']/gi)) {
      const count = match[1].split(',').map((asin) => asin.trim()).filter(isProbablyBookAsin).length;
      if (count > 1) addBulkOfferUnitPriceCandidates(candidates, count, extractPrices(html));
    }
  }

  return chooseBulkOfferUnitPrice(candidates, expectedCount);
}

function countBulkOfferAsins(fragment) {
  const asins = new Set();

  for (const match of String(fragment || '').matchAll(/<input\b[^>]*>/gi)) {
    const input = match[0];
    const name = extractAttribute(input, 'name');
    if (!/^items\[\d+\]\.action\.asin$/i.test(name)) continue;

    const asin = extractAttribute(input, 'value').toUpperCase();
    if (isProbablyBookAsin(asin)) asins.add(asin);
  }

  for (const match of String(fragment || '').matchAll(/\bdata-offer-asins=["']([^"']+)["']/gi)) {
    for (const asin of match[1].split(',')) {
      const normalized = asin.trim().toUpperCase();
      if (isProbablyBookAsin(normalized)) asins.add(normalized);
    }
  }

  return asins.size;
}

function addBulkOfferUnitPriceCandidates(candidates, count, prices) {
  for (const price of prices) {
    if (!Number.isFinite(price) || price <= 0 || price % count !== 0) continue;

    const unitPrice = price / count;
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;

    const candidate = candidates.get(unitPrice) || {
      unitPrice,
      counts: new Set(),
      totals: new Set()
    };
    candidate.counts.add(count);
    candidate.totals.add(price);
    candidates.set(unitPrice, candidate);
  }
}

function chooseBulkOfferUnitPrice(candidates, expectedCount = 0) {
  const expected = Number(expectedCount) || 0;
  const ranked = [...candidates.values()]
    .filter((candidate) => candidate.counts.size >= 2 || (expected > 1 && candidate.counts.has(expected)))
    .sort((left, right) => {
      const leftExpected = expected > 1 && left.counts.has(expected) ? 1 : 0;
      const rightExpected = expected > 1 && right.counts.has(expected) ? 1 : 0;
      if (leftExpected !== rightExpected) return rightExpected - leftExpected;
      if (left.counts.size !== right.counts.size) return right.counts.size - left.counts.size;
      const leftMax = Math.max(...left.counts);
      const rightMax = Math.max(...right.counts);
      if (leftMax !== rightMax) return rightMax - leftMax;
      return right.unitPrice - left.unitPrice;
    });

  return ranked[0]?.unitPrice ?? null;
}

function extractKindlePurchaseOffer(html, asin) {
  const scopes = [
    extractKindleSwatch(html),
    extractFragmentAroundPattern(html, /kindleExtraMessage/i),
    extractFragmentAroundPattern(html, /oneClick|one-click|buybox/i)
  ].filter(Boolean);

  for (const scope of scopes) {
    const offer = extractPurchaseTextOffer(scope);
    if (offer.price != null) return offer;
  }

  for (const scope of scopes) {
    const offer = extractScopedKindlePriceOffer(scope);
    if (offer.price != null) return offer;
  }

  return extractBifrostOffer(html, asin);
}

function extractKindleSwatch(html) {
  const marker = String(html || '').search(/id=["']tmm-grid-swatch-KINDLE["']/i);
  if (marker === -1) return '';

  const afterMarker = html.slice(marker + 1);
  const nextSwatch = afterMarker.search(/id=["']tmm-grid-swatch-[A-Z_]+["']/i);
  const start = Math.max(0, marker - 1000);
  const end = nextSwatch === -1 ? marker + 6000 : marker + 1 + nextSwatch;
  return html.slice(start, Math.min(html.length, end));
}

function extractFragmentAroundPattern(html, pattern, before = 1200, after = 2400) {
  const value = String(html || '');
  const index = value.search(pattern);
  if (index === -1) return '';
  return value.slice(Math.max(0, index - before), Math.min(value.length, index + after));
}

function extractPurchaseTextOffer(html) {
  const text = cleanText(html).replace(/\s+/g, '');
  const match = text.match(
    /(?:または)?(?:￥|¥)\s*([0-9][0-9,]*)(?:\(([0-9][0-9,]*)pt\)|（([0-9][0-9,]*)pt）|([0-9][0-9,]*)ポイント)?で購入/i
  );
  if (!match) return { price: null, points: null };

  const price = parsePrice(match[1]);
  return {
    price,
    points: parseOptionalPoints(match[2] || match[3] || match[4]),
    source: 'purchase_text'
  };
}

function extractScopedKindlePriceOffer(html) {
  const text = cleanText(html);
  const prices = extractPrices(html);
  if (!prices.length) return { price: null, points: null };

  const preferredPrice = chooseLikelyKindlePrice(prices, html);
  if (preferredPrice != null && preferredPrice > 0) {
    const points = extractPointsNearPrice(html, preferredPrice);
    if (points == null || points <= preferredPrice) {
      return {
        price: preferredPrice,
        points,
        source: 'scoped_price'
      };
    }
  }

  for (const nonZeroPrice of prices.filter((price) => price > 0)) {
    if (isAmbiguousTinyFallbackPrice(nonZeroPrice, prices, html)) continue;
    const points = extractPointsNearPrice(html, nonZeroPrice);
    if (points != null && points > nonZeroPrice) continue;
    return {
      price: nonZeroPrice,
      points,
      source: 'scoped_price'
    };
  }

  if (prices.includes(0) && hasExplicitFreeKindlePrice(html) && !/Kindle Unlimited/i.test(text)) {
    return { price: 0, points: 0, source: 'scoped_price' };
  }

  return { price: null, points: null };
}

function extractKindlePurchasePoints(html, currentPrice) {
  const scopes = [
    extractKindleSwatch(html),
    extractFragmentAroundPattern(html, /ebook-price-value|priceToPay|kindleExtraMessage|oneClick|one-click|buybox|CoP-ActualPrice/i, 2200, 5200)
  ].filter(Boolean);

  for (const scope of scopes) {
    const near = extractPointsNearPrice(scope, currentPrice);
    if (near != null) return near;

    const scoped = extractPoints(scope, currentPrice);
    if (scoped > 0) return scoped;
  }

  return null;
}

function extractBifrostOffer(html, asin) {
  const direct = matchBifrostPrice(decodeURIComponentSafe(html), asin);
  if (direct.price != null) return direct;

  let inspected = 0;
  for (const match of String(html || '').matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
    inspected += 1;
    if (inspected > 300) break;

    const decoded = decodeBase64Like(match[0]);
    if (!decoded) continue;

    const offer = matchBifrostPrice(decoded, asin);
    if (offer.price != null) return offer;
  }

  return { price: null, points: null };
}

function matchBifrostPrice(value, asin) {
  const text = String(value || '');
  const asinPattern = asin ? `${escapeRegExp(asin)}:Buy:` : ':Buy:';
  const pattern = new RegExp(`${asinPattern}[^:]*:([0-9]+(?:\\.[0-9]+)?):JPY`, 'i');
  const match = text.match(pattern);
  return {
    price: match ? parsePrice(match[1]) : null,
    points: null,
    source: match ? 'bifrost' : ''
  };
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function decodeBase64Like(value) {
  try {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function extractPointsNearPrice(html, price) {
  if (price == null) return null;
  const text = cleanText(html).replace(/\s+/g, '');
  const pattern = new RegExp(
    `(?:￥|¥)\\s*${yenAmountPatternForPrice(price)}(?:\\(([0-9][0-9,]*)pt\\)|（([0-9][0-9,]*)pt）|[^0-9]{0,20}([0-9][0-9,]*)ポイント)`,
    'i'
  );
  const match = text.match(pattern);
  const points = parseOptionalPoints(match?.[1] || match?.[2] || match?.[3]);
  return points != null && points <= price ? points : null;
}

function yenAmountPatternForPrice(price) {
  const rounded = Math.round(Number(price));
  const rawPrice = escapeRegExp(String(rounded));
  const commaPrice = escapeRegExp(rounded.toLocaleString('ja-JP'));
  return `(?:${commaPrice}|${rawPrice})(?![0-9,])`;
}

function parseOptionalPoints(value) {
  if (value == null || value === '') return null;
  return parsePoints(value);
}

function extractListPrice(html, currentPrice) {
  const strikePattern = /<span[^>]+class=["'][^"']*a-text-price[^"']*["'][^>]*>[\s\S]*?(?:￥|¥)\s*([0-9][0-9,]*)/gi;
  const candidates = [];
  for (const scope of listPriceEvidenceScopes(html, currentPrice)) {
    for (const match of scope.matchAll(strikePattern)) {
      if (isSeriesBundleListPriceContext(scope, match.index ?? 0)) continue;
      const price = parsePrice(match[1]);
      if (price != null) candidates.push(price);
    }
  }
  const higher = candidates.filter((price) => currentPrice == null || price > currentPrice);
  return higher.sort((a, b) => a - b)[0] ?? null;
}

function listPriceReferencePrice(currentPrice, options = {}) {
  const current = nullableNumber(currentPrice);
  const explicitFloor = nullableNumber(options.minimumListPriceExclusive);
  if (current == null) return explicitFloor;
  if (explicitFloor == null) return current;
  return Math.max(current, explicitFloor);
}

function isSeriesBundleListPriceContext(text, index, radius = 900) {
  const context = cleanText(
    String(text || '').slice(Math.max(0, index - radius), Math.min(String(text || '').length, index + radius))
  );
  return /(?:series-bundle|bundle|bulk|hulkbuy|collection|まとめ買い|全巻|セット|シリーズ.{0,24}(?:まとめ|一括|全巻|セット|購入)|(?:まとめ|一括|全巻|セット).{0,24}シリーズ)/i.test(
    context
  );
}

function listPriceEvidenceScopes(html, currentPrice) {
  const value = String(html || '');
  return [
    extractKindleSwatch(value),
    extractFragmentAroundPattern(value, /corePriceDisplay|corePrice_feature|apex_desktop|priceToPay|ebook-price-value|kindleExtraMessage|oneClick|one-click|buybox|CoP-ActualPrice/i, 1800, 4200),
    extractFragmentAroundPrice(value, currentPrice)
  ].filter(Boolean);
}

function extractPoints(html, currentPrice = null) {
  const value = decodeHtml(html);
  const matches = [
    ...value.matchAll(/([0-9][0-9,]*)\s*ポイント/g),
    ...value.matchAll(/\(([0-9][0-9,]*)\s*pt\)/gi),
    ...value.matchAll(/\b([0-9][0-9,]*)\s*pt\b/gi)
  ];
  const points = matches
    .map((match) => parsePoints(match[1]))
    .filter(Number.isFinite)
    .filter((point) => currentPrice == null || point <= currentPrice);
  return points.length ? Math.max(...points) : 0;
}

function cleanText(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\|.*Amazon.*$/i, '')
    .trim();
}

function cleanContributorText(value) {
  return cleanMetadataText(value).replace(/^フォロー,\s*/i, '');
}

function cleanMetadataText(value) {
  const text = cleanText(value);
  if (!text) return '';
  if (text.length > 120) return '';
  if (/function|P\.when|A\.declarative|window\.ue|var\s+/i.test(text)) return '';
  return text;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&yen;/gi, '￥')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCharCode(Number(num)));
}

function decodeJsonEscapes(value) {
  return String(value || '')
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
