import crypto from 'node:crypto';

const ASIN_PATTERN = /[A-Z0-9]{10}/i;
const ASIN_GLOBAL_PATTERN = /[A-Z0-9]{10}/gi;
const DEFAULT_FETCH_TIMEOUT_MS = 4000;

const AMAZON_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
  'Cache-Control': 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
};

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
    return (
      url.searchParams.get('binding') === 'kindle_edition' ||
      url.searchParams.get('ref')?.includes('dbs_dp_rwt_sb_pc_tkin') ||
      url.searchParams.get('ref_')?.includes('dbs_dp_rwt_sb_pc_tkin')
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

export async function fetchExternalKindleSeriesItems(input) {
  const sourceAsin = extractAsin(input);
  if (!sourceAsin) return null;

  const candidates = [
    `https://premium.gamepedia.jp/kindle/series/${sourceAsin}`
  ];

  for (const url of candidates) {
    try {
      const html = await fetchHtml(url);
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
  const html = await fetchHtml(url);
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
  return fetchHtml(url.toString(), { timeoutMs: options.timeoutMs ?? 6000 });
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
  if (normalizeSeriesNameForMatch(kinpomeSeriesBaseName(item.title)) !== normalizeSeriesNameForMatch(seriesName)) return null;

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

function kinpomeSeriesBaseName(title) {
  return cleanTitle(title)
    .replace(/\s*[（(][^（）()]{0,80}(?:コミックス|コミック|文庫|新書|DX|KC|REX|ZERO-SUM|モーニング|イブニング|アフタヌーン|ビッグ|スピリッツ|ジャンプ|マガジン|サンデー|チャンピオン|ヒーローズ|ebook|Kindle)[^（）()]{0,80}[）)]\s*$/i, '')
    .replace(/\s*[（(]\s*(?:第\s*)?[0-9０-９]{1,3}\s*(?:巻)?\s*[）)]\s*$/i, '')
    .replace(/\s*(?:第\s*)?[0-9０-９]{1,3}\s*巻\s*$/i, '')
    .replace(/\s+[0-9０-９]{1,3}\s*$/i, '')
    .trim();
}

export async function fetchKindleSeriesAsins(input) {
  const series = await fetchKindleSeriesItems(input);
  return series.items.map((item) => item.asin);
}

export function extractKindleSeriesAsinsFromHtml(html) {
  return extractKindleSeriesItemsFromHtml(html).map((item) => item.asin);
}

export function isKindleCollectionPageHtml(html, sourceAsin = '') {
  return isKindleCollectionPage(html, sourceAsin, extractKindleSeriesItemsFromHtml(html));
}

export function extractKindleSeriesItemsFromHtml(html) {
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

export function extractExternalKindleSeriesItemsFromHtml(html, sourceAsin = '') {
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
  const inputUrl = typeof options === 'string' ? options : options.url || '';

  if ((provider === 'auto' || provider === 'keepa') && process.env.KEEPA_API_KEY) {
    try {
      return await fetchFromKeepa(asin);
    } catch (error) {
      errors.push(`Keepa: ${error.message}`);
      if (provider === 'keepa') throw error;
    }
  }

  if (provider === 'auto' || provider === 'amazon_html') {
    try {
      return await fetchFromAmazonHtml(asin, inputUrl);
    } catch (error) {
      errors.push(`Amazon HTML: ${error.message}`);
      if (provider === 'amazon_html') throw error;
    }
  }

  throw new Error(errors.join(' / ') || '価格取得プロバイダが設定されていません');
}

export async function fetchAmazonHtmlSnapshot(asin, url = '') {
  return fetchFromAmazonHtml(asin, url);
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

async function fetchFromAmazonHtml(asin, inputUrl = '') {
  let lastSnapshot = null;
  const errors = [];

  for (const url of amazonProductCandidateUrls(asin, inputUrl)) {
    try {
      const html = await fetchAmazonHtml(url);
      const snapshot = isAmazonSearchUrl(url)
        ? extractAmazonSearchSnapshotFromHtml(html, asin, url, 'amazon_html')
        : extractAmazonHtmlSnapshotFromHtml(html, asin, url, 'amazon_html');
      if (snapshot.currentPrice != null) return snapshot;
      lastSnapshot = snapshot;
    } catch (error) {
      errors.push(`${amazonFetchUrlLabel(url)}: ${error.message}`);
    }
  }

  if (shouldUseAmazonReaderFallback()) {
    try {
      const snapshot = await fetchFromAmazonReader(asin, inputUrl);
      if (snapshot.currentPrice != null || !lastSnapshot) return snapshot;
      lastSnapshot = mergeSnapshotLike(lastSnapshot, snapshot);
    } catch (error) {
      errors.push(`reader: ${error.message}`);
    }
  }

  if (lastSnapshot) return lastSnapshot;
  throw new Error(compactFetchErrors(errors) || 'Amazon HTMLで商品情報を取得できませんでした');
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
    add(`https://${host}/s?k=${normalizedAsin}&i=digital-text`, { skipAsinCheck: true });
  } catch {
    // Keep the canonical URL candidates.
  }

  return urls;
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

async function fetchFromAmazonReader(asin, inputUrl = '') {
  const sourceUrl = amazonProductCandidateUrls(asin, inputUrl)[0] || amazonUrlForAsin(asin);
  const readerUrl = amazonReaderUrl(sourceUrl);
  const text = await fetchHtml(readerUrl);
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
  return {
    ...base,
    title: base.title || overlay.title,
    author: base.author || overlay.author,
    publisher: base.publisher || overlay.publisher,
    imageUrl: base.imageUrl || overlay.imageUrl,
    currentPrice: base.currentPrice ?? overlay.currentPrice,
    currentPoints: base.currentPoints ?? overlay.currentPoints,
    effectivePrice: base.effectivePrice ?? overlay.effectivePrice,
    listPrice: base.listPrice ?? overlay.listPrice,
    provider: base.currentPrice == null && overlay.currentPrice != null ? overlay.provider : base.provider
  };
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

  const readerError = unique.findLast((error) => error.startsWith('reader:'));
  const searchError = unique.findLast((error) => error.startsWith('/s?'));
  return [...new Set([...unique.slice(0, readerError ? 2 : 3), searchError, readerError].filter(Boolean))].join(' / ');
}

function extractAmazonHtmlSnapshotFromHtml(html, asin, url, provider) {
  const base = extractAmazonHtmlSnapshotBase(html, asin, url, provider);
  const kindleOffer = extractKindlePurchaseOffer(html, asin);
  const allPrices = extractPrices(html);
  let currentPrice = kindleOffer.price ?? chooseLikelyKindlePrice(allPrices);
  let listPrice = extractListPrice(html, currentPrice);
  let currentPoints =
    kindleOffer.price != null
      ? kindleOffer.points ?? 0
      : extractPointsNearPrice(html, currentPrice) ?? extractPoints(html, currentPrice);
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

  const prices = extractPrices(fragment);
  let currentPrice = chooseLikelyKindlePrice(prices);
  const title =
    cleanTitle(fragment.match(/<h2\b[^>]*aria-label=["']([^"']+)["']/i)?.[1] || '') ||
    cleanTitle(fragment.match(/<h2\b[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '') ||
    extractItemTitle(fragment, asin);
  const imageUrl = extractItemImage(fragment);
  const productUrl = absoluteAmazonHref(extractAsinHref(fragment, asin)) || amazonUrlForAsin(asin);
  let currentPoints = extractPointsNearPrice(fragment, currentPrice) ?? extractPoints(fragment, currentPrice);
  let listPrice = extractListPrice(fragment, currentPrice);
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
    value.lastIndexOf('<div role="listitem"', index),
    value.lastIndexOf('<div', index)
  ].filter((position) => position >= 0);
  const start = startCandidates.length ? Math.max(...startCandidates) : Math.max(0, index - 2000);
  const nextItem = value.indexOf('<div role="listitem"', index + normalizedAsin.length);
  const end = nextItem > index ? nextItem : Math.min(value.length, index + 24000);
  return value.slice(start, end);
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
  return fetchHtml(url, { ...options, rejectRobotCheck: true });
}

async function fetchHtml(url, options = {}) {
  const timeoutMs = readPositiveInteger(
    options.timeoutMs ?? process.env.HTTP_FETCH_TIMEOUT_MS,
    DEFAULT_FETCH_TIMEOUT_MS
  );
  const { signal, cleanup } = requestSignal(options.signal, timeoutMs);

  try {
    const response = await fetch(url, { headers: AMAZON_HEADERS, signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    if (options.rejectRobotCheck && /captcha|robot check|自動化されたアクセス/i.test(html)) {
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

function isProbablyBookAsin(asin) {
  return /^B[A-Z0-9]{9}$/.test(asin);
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
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
  const value = decodeHtml(html);
  const pricePatterns = [
    /(?:￥|¥)\s*([0-9][0-9,]*)/g,
    /<span[^>]+class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([0-9,]+)\s*<\/span>/gi
  ];

  for (const pattern of pricePatterns) {
    for (const match of value.matchAll(pattern)) {
      const price = parsePrice(match[1]);
      if (price != null) prices.add(price);
    }
  }

  return [...prices].filter((price) => price >= 0).sort((a, b) => a - b);
}

function chooseLikelyKindlePrice(prices) {
  if (!prices.length) return null;
  return prices[0];
}

function correctImplausibleKindlePrice({ currentPrice, currentPoints, listPrice, prices, html }) {
  if (
    isSuspiciousDiscountLikePrice(currentPrice, currentPoints, listPrice, prices) ||
    isSuspiciousAboveListPrice(currentPrice, listPrice)
  ) {
    return { currentPrice: null, currentPoints: 0 };
  }

  return { currentPrice, currentPoints };
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
    points: parseOptionalPoints(match[2] || match[3] || match[4])
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
      points
    };
  }

  if (prices.includes(0) && !/Kindle Unlimited/i.test(text)) {
    return { price: 0, points: 0 };
  }

  return { price: null, points: null };
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
    points: null
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
