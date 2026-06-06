export function bookListPayload(books = []) {
  return { books: compactBooksPayload(books) };
}

export function compactBooksPayload(books = []) {
  const context = {
    emittedSeriesLowest: new Set(),
    emittedSeriesSourceUrl: new Set()
  };
  return books.map((book) => compactBookPayload(book, context));
}

function compactBookPayload(book = {}, context) {
  const result = {};
  for (const [key, value] of Object.entries(book)) {
    if (shouldDropBookPayloadField(key, value, book, context)) continue;
    result[key] = value;
  }
  return result;
}

function shouldDropBookPayloadField(key, value, book, context) {
  if (value == null || value === '') return true;
  if (value === false) return true;
  if (key === 'currentPoints' && Number(value) === 0) return true;
  if (key === 'importMode' && value === 'single') return true;
  if (key === 'seriesExpectedCount' && Number(value) <= 1) return true;
  if (
    key === 'provider' ||
    key === 'updatedAt' ||
    key === 'previousEffectivePrice' ||
    key === 'lowestPrice' ||
    key === 'seriesCompletedAt' ||
    key === 'discountReferenceSource'
  ) {
    return true;
  }
  if (key === 'amazonUrl' && value === canonicalAmazonUrlForAsin(book.asin)) return true;
  if (key === 'sourceUrl' && shouldEmitSeriesFieldOnce(book, context.emittedSeriesSourceUrl) === false) return true;
  if (
    key === 'seriesLowestCheckedAt' ||
    key === 'seriesLatestObservedEffectiveTotal' ||
    key === 'seriesLatestObservedAt' ||
    key === 'seriesObservedBookCount' ||
    key === 'seriesObservedHistoryCount'
  ) {
    return true;
  }
  if (key === 'seriesLowestEffectiveTotal') {
    if (shouldEmitSeriesFieldOnce(book, context.emittedSeriesLowest) === false) return true;
  }
  return false;
}

function shouldEmitSeriesFieldOnce(book, emittedScopes) {
  const scope = book.seriesKey || book.sourceUrl || '';
  if (!scope) return true;
  if (emittedScopes.has(scope)) return false;
  emittedScopes.add(scope);
  return true;
}

function canonicalAmazonUrlForAsin(asin) {
  return /^B[A-Z0-9]{9}$/i.test(String(asin || '')) ? `https://www.amazon.co.jp/dp/${String(asin).toUpperCase()}` : '';
}
