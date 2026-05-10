import crypto from 'node:crypto';

const ASIN_PATTERN = /[A-Z0-9]{10}/i;
const ASIN_GLOBAL_PATTERN = /[A-Z0-9]{10}/gi;
const DEFAULT_FETCH_TIMEOUT_MS = 4000;
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

export function extractAsin(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  const direct = value.match(/^[A-Z0-9]{10}$/i);
  if (direct) return direct[0].toUpperCase();

  try {
    const url = new URL(value);
    const pathMatch = url.pathname.match(/\/(?:dp|gp\/product|exec\/obidos\/ASIN)\/([A-Z0-9]{10})/i);
    if (pathMatch) return pathMatch[1].toUpperCase();

    for (const key of ['asin', 'ASIN']) {
      const param = url.searchParams.get(key);
      if (param && ASIN_PATTERN.test(param)) {
        return param.match(ASIN_PATTERN)[0].toUpperCase();
      }
    }
  } catch {
    const anywhere = value.match(ASIN_PATTERN);
    if (anywhere) return anywhere[0].toUpperCase();
  }

  return null;
}

export function amazonUrlForAsin(asin) {
  const host = process.env.AMAZON_HOST || 'www.amazon.co.jp';
  return `https://${host}/dp/${asin}`;
}

export function isKindleSeriesUrl(input) {
  try {
    const url = new URL(String(input || '').trim());
    const ref = `${url.searchParams.get('ref') || ''} ${url.searchParams.get('ref_') || ''}`;
    return (
      /\/series\//i.test(url.pathname) ||
      /dbs_|dbs-|saga_sdp|hulkbuy|dbs_dp_rwt_sb_pc_tkin|dbs_s_ks_series_rwt_tkin/i.test(ref)
    );
  } catch {
    return false;
  }
}

export async function fetchKindleSeriesItems(input, options = {}) {
  const sourceAsin = extractAsin(input);
  let amazonResult = null;
  let amazonError = null;

  try {
    const { url, html } = await fetchAmazonSeriesHtml(input, options);
    let items = extractKindleSeriesItemsFromHtml(html);

    if (options.requireCollectionPage && !isKindleCollectionPage(html, sourceAsin, items)) {
      items = [];
    }

    amazonResult = buildKindleSeriesResult({
      seriesName: extractSeriesName(html),
      sourceAsin,
      sourcePriceSeed: extractSeriesSourcePriceSeedFromHtml(html, sourceAsin, url, items),
      expectedVolumeCount: extractSeriesExpectedCount(html) || maxSeriesItemVolume(items) || items.length,
      completed: extractSeriesCompletionStatus(html),
      items
    });
  } catch (error) {
    amazonError = error;
  }

  if (options.allowReaderFallback !== false && shouldTryAmazonSeriesReaderFallback(amazonResult, amazonError)) {
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

function buildKindleSeriesResult(series) {
  const limit = readPositiveInteger(process.env.SERIES_IMPORT_LIMIT, null);
  const items = normalizeKindleSeriesItemVolumes(series.items || []);
  return {
    ...series,
    items: limit == null ? items : items.slice(0, limit)
  };
}

function normalizeKindleSeriesItemVolumes(items) {
  return items.map((item, index) => ({
    ...item,
    volume: item.volume || extractExternalVolumeFromTitle(item.title) || String(index + 1)
  }));
}

function shouldTryAmazonSeriesReaderFallback(series, error) {
  if (!shouldUseAmazonReaderFallback()) return false;
  if (error || !series) return true;
  if (!Array.isArray(series.items) || series.items.length <= 1) return true;

  const expected = Number(series.expectedVolumeCount) || 0;
  return expected > series.items.length;
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

async function fetchAmazonSeriesHtml(input, options = {}) {
  const urls = kindleSeriesCandidateUrls(input);
  let lastError;

  for (const url of urls) {
    try {
      return { url, html: await fetchAmazonHtml(url, options) };
    } catch (error) {
      lastError = error;
      if (isAmazonBlockingFetchError(error)) break;
    }
  }

  throw lastError || new Error('Amazonシリーズページを取得できませんでした');
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

function extractKindleSeriesItemsFromHtml(html) {
  const ordered = new Map();
  const value = String(html || '');
  const seriesName = extractSeriesName(value);
  const seriesImageUrl = extractMeta(value, 'og:image');
  const childItems = extractChildAsinListItems(value);

  const bulkOfferItems = extractLargestBulkOfferItems(value, { seriesName, seriesImageUrl });
  if (bulkOfferItems.length > childItems.length) {
    const childByAsin = new Map(childItems.map((item) => [item.asin, item]));
    return bulkOfferItems.map((item) => mergeBulkSeriesItem(item, childByAsin.get(item.asin)));
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

  const parenthesized = value.match(/[（(]\s*([0-9０-９]{1,3})\s*[）)]\s*$/);
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

  for (const url of amazonProductCandidateUrls(asin, inputUrl)) {
    try {
      const html = await fetchAmazonHtml(url, options);
      const snapshot = isAmazonSearchUrl(url)
        ? extractAmazonSearchSnapshotFromHtml(html, asin, url, 'amazon_html')
        : extractAmazonHtmlSnapshotFromHtml(html, asin, url, 'amazon_html');
      if (snapshot.currentPrice != null) return snapshot;
      lastSnapshot = snapshot;
    } catch (error) {
      if (isPermanentKindleProductError(error)) throw error;
      errors.push(`${amazonFetchUrlLabel(url)}: ${error.message}`);
      if (isAmazonBlockingFetchError(error)) {
        amazonBlocked = true;
        break;
      }
    }
  }

  if (!amazonBlocked && shouldUseAmazonReaderFallback()) {
    try {
      const snapshot = await fetchFromAmazonReader(asin, inputUrl, options);
      if (snapshot.currentPrice != null) return lastSnapshot ? mergeSnapshotLike(lastSnapshot, snapshot) : snapshot;
      lastSnapshot = lastSnapshot ? mergeSnapshotLike(lastSnapshot, snapshot) : snapshot;
    } catch (error) {
      if (isPermanentKindleProductError(error)) throw error;
      errors.push(`reader: ${error.message}`);
    }
  }

  try {
    const snapshot = await fetchFromKintyaku(asin, snapshotSeedFromOptions(asin, options, lastSnapshot), options);
    if (snapshot.currentPrice != null) return lastSnapshot ? mergeSnapshotLike(lastSnapshot, snapshot) : snapshot;
    lastSnapshot = lastSnapshot ? mergeSnapshotLike(lastSnapshot, snapshot) : snapshot;
  } catch (error) {
    errors.push(`Kintyaku: ${error.message}`);
  }

  try {
    const snapshot = await fetchFromListasin(asin, snapshotSeedFromOptions(asin, options, lastSnapshot), options);
    return lastSnapshot ? mergeSnapshotLike(lastSnapshot, snapshot) : snapshot;
  } catch (error) {
    errors.push(`listasIn: ${error.message}`);
  }

  if (!lastSnapshot && isLegacyPhysicalProductAsin(asin)) throw nonKindleProductError();

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
  return {
    asin: normalizedAsin,
    title: bestSnapshotTitle(lastSnapshot?.title, options.title),
    author: lastSnapshot?.author || options.author || '',
    publisher: lastSnapshot?.publisher || options.publisher || '',
    imageUrl: lastSnapshot?.imageUrl || options.imageUrl || '',
    amazonUrl: lastSnapshot?.amazonUrl || options.amazonUrl || options.sourceUrl || amazonUrlForAsin(normalizedAsin),
    seriesName: options.seriesName || '',
    volume: options.volume || ''
  };
}

function titleFromSnapshotSeed(seed = {}) {
  if (seed.seriesName && seed.volume) return `${seed.seriesName} ${seed.volume}`;
  return '';
}

function amazonProductCandidateUrls(asin, inputUrl = '') {
  const normalizedAsin = String(asin || '').toUpperCase();
  const urls = [];
  const add = (value, options = {}) => {
    if (!value || urls.includes(value)) return;
    if (!options.skipAsinCheck && extractAsin(value) !== normalizedAsin) return;
    urls.push(value);
  };

  add(inputUrl);
  add(withAmazonSearchParams(inputUrl, { binding: 'kindle_edition', ref: 'dbs_dp_rwt_sb_pc_tkin' }));

  const base = amazonUrlForAsin(normalizedAsin);
  add(base);
  add(withAmazonSearchParams(base, { binding: 'kindle_edition', ref: 'dbs_dp_rwt_sb_pc_tkin' }));

  try {
    const baseUrl = new URL(base);
    const host = baseUrl.host;
    add(`https://${host}/-/en/dp/${normalizedAsin}`);
    add(`https://${host}/gp/product/${normalizedAsin}`);
    add(`https://${host}/-/en/gp/product/${normalizedAsin}`);
    add(`https://${host}/gp/product/${normalizedAsin}?storeType=ebooks`);
    add(`https://${host}/gp/product/${normalizedAsin}?binding=kindle_edition&ref=dbs_dp_rwt_sb_pc_tkin`);
    add(`https://${host}/gp/aw/d/${normalizedAsin}`);
    for (const query of amazonSearchQueriesForInput(inputUrl, normalizedAsin)) {
      add(`https://${host}/s?k=${encodeURIComponent(query)}&i=digital-text`, { skipAsinCheck: true });
    }
    add(`https://${host}/s?k=${normalizedAsin}&i=digital-text`, { skipAsinCheck: true });
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

async function fetchFromAmazonReader(asin, inputUrl = '', options = {}) {
  const sourceUrl = amazonProductCandidateUrls(asin, inputUrl)[0] || amazonUrlForAsin(asin);
  const readerUrl = amazonReaderUrl(sourceUrl);
  const text = await fetchHtml(readerUrl, options);
  return extractAmazonReaderSnapshotFromText(text, asin, sourceUrl, 'amazon_reader');
}

async function fetchKindleSeriesItemsFromAmazonReader(input, options = {}) {
  const urls = kindleSeriesCandidateUrls(input);
  let lastError;

  for (const sourceUrl of urls) {
    try {
      const text = await fetchHtml(amazonReaderUrl(sourceUrl), options);
      const result = extractKindleSeriesItemsFromAmazonReaderText(text, input, sourceUrl, options);
      if (result.items.length > 1) return result;
      lastError = new Error('readerでシリーズ内のKindle ASINを取得できませんでした');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('readerでシリーズページを取得できませんでした');
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

function extractKindleSeriesItemsFromAmazonReaderText(text, input, sourceUrl, options = {}) {
  const value = String(text || '');
  const sourceAsin = extractAsin(input);
  const seriesName = extractAmazonReaderSeriesName(value);
  const expectedVolumeCount = extractAmazonReaderSeriesExpectedCount(value);
  let items = extractAmazonReaderSeriesItems(value, {
    seriesName,
    expectedVolumeCount
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

function extractAmazonReaderSeriesName(text) {
  const heading =
    String(text || '').match(/^#\s+(.+?\([0-9０-９]+\s+book\s+series\).*?)$/im)?.[1] ||
    String(text || '').match(/^Title:\s*(.+?\([0-9０-９]+\s+book\s+series\).*?)$/im)?.[1] ||
    String(text || '').match(/^#\s+(.+)$/m)?.[1] ||
    '';

  return cleanTitle(heading)
    .replace(/^Amazon\.co\.jp:\s*/i, '')
    .replace(/\s*\(\s*[0-9０-９]+\s+book\s+series\s*\)\s*Kindle Edition.*$/i, '')
    .replace(/\s*Kindle Edition.*$/i, '')
    .replace(/\s*:\s*Kindle Store.*$/i, '')
    .trim() || 'Kindle シリーズ';
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
  const block = extractAmazonReaderSeriesBlock(text);
  const candidates = preferredAmazonReaderSeriesLinkCandidates(
    extractAmazonReaderSeriesLinkCandidates(block),
    expectedVolumeCount
  )
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
      currentPrice: null,
      currentPoints: 0,
      effectivePrice: null,
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
    /^#\s+.+?\([0-9０-９]+\s+book\s+series\).*$/im,
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
    /^###\s+Popular/im
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

  for (const match of value.matchAll(/\[!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g)) {
    const href = cleanMarkdownUrl(match[3]);
    const asin = extractAsin(href) || extractAsin(decodeURIComponentSafe(href));
    const imageUrl = decodeHtml(match[2]);
    if (!asin || !isProbablyBookAsin(asin)) continue;
    candidates.push({
      asin,
      href,
      title: cleanMarkdownText(match[4] || match[1] || ''),
      alt: cleanMarkdownText(match[1] || ''),
      imageUrl: isAmazonImage(imageUrl) ? imageUrl : '',
      index: match.index ?? 0,
      kind: 'image'
    });
  }

  for (const match of value.matchAll(/\[([^\]\n]{1,300})\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g)) {
    const rawTitle = match[1] || '';
    if (rawTitle.startsWith('!')) continue;
    const href = cleanMarkdownUrl(match[2]);
    const asin = extractAsin(href) || extractAsin(decodeURIComponentSafe(href));
    if (!asin || !isProbablyBookAsin(asin)) continue;
    candidates.push({
      asin,
      href,
      title: cleanMarkdownText(match[3] || rawTitle),
      alt: '',
      imageUrl: '',
      index: match.index ?? 0,
      kind: 'link'
    });
  }

  return candidates;
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
  if (/saga_sdp|hulkbuy|dbs_|dbs-|series|binding=kindle_edition|kindle_edition/i.test(href)) {
    return true;
  }

  const normalizedSeriesName = normalizeReaderImageText(seriesName);
  const normalizedTitle = normalizeReaderImageText(`${candidate.title || ''} ${candidate.alt || ''}`);
  if (
    normalizedSeriesName &&
    normalizedSeriesName !== normalizeReaderImageText('Kindle シリーズ') &&
    normalizedTitle.includes(normalizedSeriesName)
  ) {
    return true;
  }

  return candidate.kind === 'image' && expectedVolumeCount > 1;
}

function isAmazonReaderNoiseLinkCandidate(candidate) {
  const href = decodeURIComponentSafe(candidate.href || '');
  const title = cleanText(`${candidate.title || ''} ${candidate.alt || ''}`);

  return (
    /customerReviews|product-reviews|\/ap\/signin|\/ap\/register|#customerReviews/i.test(href) ||
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

function extractAmazonHtmlSnapshotFromHtml(html, asin, url, provider) {
  assertKindleBookProductPage(html);
  const base = extractAmazonHtmlSnapshotBase(html, asin, url, provider);
  const kindleOffer = extractKindlePurchaseOffer(html, asin);
  const allPrices = extractPrices(html);
  let currentPrice = kindleOffer.price ?? chooseLikelyKindlePrice(allPrices, html);
  let listPrice = extractListPrice(html, currentPrice);
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
  listPrice = extractListPrice(html, currentPrice) ?? listPrice;

  return normalizeSnapshot({
    ...base,
    currentPrice,
    listPrice,
    currentPoints
  });
}

function extractAmazonSearchSnapshotFromHtml(html, asin, url, provider) {
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
  let listPrice = extractListPrice(fragment, currentPrice);
  const inferredPrice = inferDiscountedKindlePrice(fragment, listPrice);
  if (shouldPreferInferredDiscountPrice({ currentPrice, inferredPrice, listPrice, html: fragment })) {
    currentPrice = inferredPrice;
  }
  let currentPoints = extractPointsNearPrice(fragment, currentPrice) ?? extractPoints(fragment, currentPrice);
  const corrected = correctImplausibleKindlePrice({ currentPrice, currentPoints, listPrice, prices, html: fragment });
  currentPrice = corrected.currentPrice;
  currentPoints = corrected.currentPoints;
  listPrice = extractListPrice(fragment, currentPrice) ?? listPrice;

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
    provider
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
  const imageUrl = extractMeta(html, 'og:image') || extractLandingImage(html);

  return {
    asin,
    title,
    author,
    publisher,
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
      noteHostFetchPenalty(options.throttleUrl || url, response);
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    if (options.rejectRobotCheck && /captcha|robot check|自動化されたアクセス|ショッピングを続けてください/i.test(html)) {
      noteHostFetchPenalty(options.throttleUrl || url, { status: 503 });
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
    imageUrl: snapshot.imageUrl || '',
    amazonUrl: snapshot.amazonUrl || amazonUrlForAsin(snapshot.asin),
    currentPrice,
    currentPoints,
    effectivePrice,
    listPrice: nullableNumber(snapshot.listPrice),
    provider: snapshot.provider
  };
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

  return (
    items.length > 1 &&
    /hulk-buy-card|Kindle版\(電子書籍\)のシリーズを購入|data-offer-asins/i.test(value) &&
    /全\s*[0-9０-９]+\s*巻|collection/i.test(cleanText(value.slice(0, 15000)))
  );
}

function isSeriesTitleHref(href) {
  return /binding=kindle_edition|dbs_mng_crcw|dbs_mng_crcw_rwt|\/series\//i.test(href);
}

function extractChildAsinListItems(html) {
  const listStart = html.indexOf('id="series-childAsin-list"');
  if (listStart === -1) return [];

  const listEndMarker = '<!-- sp:end-feature:host-btf -->';
  const listEnd = html.indexOf(listEndMarker, listStart);
  const listHtml = html.slice(listStart, listEnd === -1 ? Math.min(html.length, listStart + 220000) : listEnd);
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
    items.push({
      asin,
      title: extractChildItemTitle(fragment, asin),
      imageUrl,
      imageSource: imageUrl ? 'amazon_series_child' : '',
      amazonUrl: amazonUrlForAsin(asin)
    });
  }

  return dedupeSeriesItems(items);
}

function extractLargestBulkOfferItems(html, options = {}) {
  const value = String(html || '');
  let result = [];

  for (const match of value.matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
    const items = extractBulkOfferItemsFromFragment(match[0], options);
    if (isBetterBulkOfferCandidate(items, result)) result = items;
  }

  const wholePageItems = extractBulkOfferItemsFromFragment(value, options);
  if (isBetterBulkOfferCandidate(wholePageItems, result)) result = wholePageItems;

  for (const match of value.matchAll(/\bdata-offer-asins=["']([^"']+)["']/gi)) {
    const items = match[1]
      .split(',')
      .map((asin, index) => bulkOfferItemFromAsin(asin.trim().toUpperCase(), index, options))
      .filter(Boolean);
    if (isBetterBulkOfferCandidate(items, result)) result = items;
  }

  return dedupeSeriesItems(result);
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

  return [...records.entries()]
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
    provider: 'amazon_series_bulk'
  };
}

function isBetterBulkOfferCandidate(candidate, current) {
  if (!candidate.length) return false;
  if (candidate.length !== current.length) return candidate.length > current.length;
  return countPricedItems(candidate) > countPricedItems(current);
}

function countPricedItems(items) {
  return items.filter((item) => item.currentPrice != null).length;
}

function mergeBulkSeriesItem(bulkItem, childItem) {
  if (!childItem) return bulkItem;
  return {
    ...bulkItem,
    title: betterText(childItem.title, bulkItem.title),
    imageUrl: childItem.imageUrl || bulkItem.imageUrl || '',
    imageSource: childItem.imageUrl ? childItem.imageSource || 'amazon_series_child' : bulkItem.imageSource || '',
    amazonUrl: childItem.amazonUrl || bulkItem.amazonUrl,
    volume: childItem.volume || bulkItem.volume
  };
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
    amazonUrl: amazonUrlForAsin(asin)
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
  return {
    asin: a.asin || b.asin,
    title: betterText(a.title, b.title),
    imageUrl: a.imageUrl || b.imageUrl || '',
    imageSource: a.imageUrl ? a.imageSource || '' : b.imageSource || '',
    amazonUrl: a.amazonUrl || b.amazonUrl
  };
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
  const dynamic = fragment.match(/\bdata-a-dynamic-image=["']([^"']+)["']/i);
  if (dynamic) {
    const decoded = decodeHtml(dynamic[1]);
    const url = decoded.match(/https?:\/\/[^"']+?(?:\.jpg|\.jpeg|\.png|\.webp)/i)?.[0];
    if (isAmazonImage(url)) return url;
  }

  const attrs = ['data-src', 'data-old-hires', 'src'];
  for (const attr of attrs) {
    const value = extractAttribute(fragment, attr);
    if (isAmazonImage(value)) return value;
  }

  const url = fragment.match(/https?:\/\/[^"'\s<>]+?(?:\.jpg|\.jpeg|\.png|\.webp)/i)?.[0];
  return isAmazonImage(url) ? decodeHtml(url) : '';
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

function extractSeriesName(html) {
  return cleanTitle(
    extractById(html, 'collectionTitle') ||
      extractById(html, 'series-title') ||
      extractById(html, 'ebooksProductTitle') ||
      extractMeta(html, 'og:title') ||
      extractTag(html, 'title')
  )
    .replace(/\s*\(全\s*\d+\s*巻\).*$/, '')
    .replace(/\s*全\s*\d+\s*巻.*$/, '')
    .replace(/\s*Kindle版.*$/, '')
    .trim();
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

function extractSeriesCompletionStatus(html) {
  const value = cleanText(
    [
      extractById(html, 'collectionTitle'),
      extractById(html, 'series-title'),
      extractById(html, 'ebooksProductTitle'),
      extractMeta(html, 'description'),
      extractMeta(html, 'og:title'),
      extractTag(html, 'title'),
      extractTag(html, 'h1')
    ]
      .filter(Boolean)
      .join(' ')
  );
  if (!value) return false;

  return (
    /(?:全\s*)?[0-9０-９]{1,3}\s*巻\s*(?:完結|完)/.test(value) ||
    /(?:完結済み|完結作品|シリーズ完結|全巻完結)/.test(value) ||
    /\b(?:completed|complete)\s+series\b/i.test(value)
  );
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

function isAmazonImage(value) {
  return Boolean(value && /m\.media-amazon\.com|images-(?:fe|na)\.ssl-images-amazon\.com|\.media-amazon\./i.test(value));
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

function extractLandingImage(html) {
  const match = html.match(/data-old-hires=["']([^"']+)["']/i) || html.match(/landingImage["'][^>]+src=["']([^"']+)["']/i);
  return match ? decodeHtml(match[1]) : '';
}

function extractPrices(html) {
  const prices = new Set();
  const value = decodeJsonEscapes(decodeHtml(html));
  const pricePatterns = [
    /(?:￥|¥)\s*([0-9][0-9,]*)/g,
    /<span[^>]+class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([0-9,]+)\s*<\/span>/gi,
    /["'](?:displayPrice|priceString|formattedPrice|buyingPrice)["']\s*:\s*["'][^"']*(?:￥|¥|JPY)\s*([0-9][0-9,]*)/gi
  ];

  for (const pattern of pricePatterns) {
    for (const match of value.matchAll(pattern)) {
      const price = parsePrice(match[1]);
      if (price != null) prices.add(price);
    }
  }

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
  return prices[0];
}

function extractExplicitKindlePriceCandidates(html) {
  const candidates = new Set();
  for (const scope of priceEvidenceScopes(html)) {
    const value = decodeJsonEscapes(decodeHtml(scope));
    const patterns = [
      /(?:￥|¥)\s*([0-9][0-9,]*)/g,
      /([0-9][0-9,]*)\s*円/g,
      /\bJPY\s*([0-9][0-9,]*)/gi,
      /<span[^>]+class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([0-9,]+)\s*<\/span>/gi
    ];

    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        const price = parsePrice(match[1]);
        if (price != null) candidates.add(price);
      }
    }
  }

  return [...candidates].sort((a, b) => a - b);
}

function isLikelyPriceContext(text, index, radius = 180) {
  const context = String(text || '').slice(Math.max(0, index - radius), index + radius);
  if (isDiscountOrRewardContext(context)) return false;
  return /price|Price|価格|値段|金額|amountToPay|displayPrice|displayedPrice|buyingPrice|priceToPay|salePrice|ourPrice|listPrice|basisPrice|currentPrice|a-price|ebook-price-value|CoP-ActualPrice/i.test(context);
}

function isDiscountOrRewardContext(context) {
  return /discount|percentage|percent|saving|savings|coupon|promotion|promo|points?|reward|割引|値引|還元|ポイント|%|％/i.test(
    String(context || '')
  );
}

function correctImplausibleKindlePrice({ currentPrice, currentPoints, listPrice, prices, html }) {
  if (isSuspiciousAboveListPrice(currentPrice, listPrice)) {
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
  if (currentPrice == null) return true;
  if (!Number.isFinite(Number(listPrice)) || Number(listPrice) <= 0) return false;
  if (hasExplicitPriceDisplay(html, currentPrice) && Number(currentPrice) < Number(listPrice)) return false;
  if (Number(currentPrice) >= Number(listPrice)) return true;
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
  const rawPrice = escapeRegExp(String(price));
  const commaPrice = escapeRegExp(Number(price).toLocaleString('ja-JP'));
  const pattern = new RegExp(`(?:￥|¥)\\s*(?:${rawPrice}|${commaPrice})`);
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
  const rawPrice = escapeRegExp(String(Math.round(Number(price))));
  const commaPrice = escapeRegExp(Number(price).toLocaleString('ja-JP'));
  const pattern = new RegExp(`(?:(?:￥|¥|JPY)\\s*(?:${rawPrice}|${commaPrice})|(?:${rawPrice}|${commaPrice})\\s*円)(?!\\s*(?:%|％))`, 'i');
  return priceEvidenceScopes(html).some((scope) => pattern.test(decodeJsonEscapes(decodeHtml(scope))));
}

function priceEvidenceScopes(html) {
  const value = String(html || '');
  return [
    extractKindleSwatch(value),
    extractFragmentAroundPattern(value, /ebook-price-value|priceToPay|kindleExtraMessage|oneClick|one-click|buybox|CoP-ActualPrice/i, 2200, 5200),
    value.length <= 20000 ? value : ''
  ].filter(Boolean);
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

  for (const nonZeroPrice of prices.filter((price) => price > 0)) {
    const points = extractPointsNearPrice(html, nonZeroPrice);
    if (points != null && points > nonZeroPrice) continue;
    return {
      price: nonZeroPrice,
      points,
      source: 'scoped_price'
    };
  }

  if (prices.includes(0) && !/Kindle Unlimited/i.test(text)) {
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
  const rawPrice = escapeRegExp(String(price));
  const commaPrice = escapeRegExp(Number(price).toLocaleString('ja-JP'));
  const pattern = new RegExp(
    `(?:￥|¥)(?:${rawPrice}|${commaPrice})(?:\\(([0-9][0-9,]*)pt\\)|（([0-9][0-9,]*)pt）|[^0-9]{0,20}([0-9][0-9,]*)ポイント)`,
    'i'
  );
  const match = text.match(pattern);
  const points = parseOptionalPoints(match?.[1] || match?.[2] || match?.[3]);
  return points != null && points <= price ? points : null;
}

function parseOptionalPoints(value) {
  if (value == null || value === '') return null;
  return parsePoints(value);
}

function extractListPrice(html, currentPrice) {
  const strikePattern = /<span[^>]+class=["'][^"']*a-text-price[^"']*["'][^>]*>[\s\S]*?(?:￥|¥)\s*([0-9][0-9,]*)/gi;
  const candidates = [];
  for (const match of html.matchAll(strikePattern)) {
    const price = parsePrice(match[1]);
    if (price != null) candidates.push(price);
  }
  const higher = candidates.filter((price) => currentPrice == null || price >= currentPrice);
  return higher.sort((a, b) => a - b)[0] ?? null;
}

function extractPoints(html, currentPrice = null) {
  const value = decodeHtml(html);
  const matches = [
    ...value.matchAll(/([0-9][0-9,]*)\s*ポイント/g),
    ...value.matchAll(/\(([0-9][0-9,]*)\s*pt\)/gi)
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
