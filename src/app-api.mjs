import {
  addSeriesImports,
  checkBookById,
  deleteAllBooks,
  deleteBook,
  deleteBooks,
  deleteSeries,
  enqueueBookImportQueue,
  getDiscordWebhooks,
  getBookImportQueue,
  getHistory,
  getSettingsSummary,
  listBooks,
  runDueChecks,
  saveDiscordWebhooks,
  saveBookImportQueue,
  saveSettings,
  sendTestNotification
} from './checker.mjs';

export async function listBooksPayload() {
  return { books: compactBooksPayload(await listBooks()) };
}

export async function addBooksPayload(body = {}) {
  if (Array.isArray(body.seriesImports)) {
    return addSeriesImports(body.seriesImports, {
      fetchDetails: body.fetchDetails === true,
      recordInitialHistory: body.recordInitialHistory !== false
    });
  }

  const inputs = Array.isArray(body.urls) ? body.urls : Array.isArray(body.inputs) ? body.inputs : null;
  if (inputs) {
    return enqueueBookImportQueue(inputs);
  }

  return enqueueBookImportQueue(body.input || body.url || body.asin || '');
}

export async function deleteBooksPayload(body = {}) {
  return body.all ? deleteAllBooks() : deleteBooks(body.ids || []);
}

export async function deleteBookPayload(id) {
  await deleteBook(id);
  return { ok: true };
}

export async function deleteSeriesPayload(body = {}) {
  await deleteSeries(body.seriesKey || '', body.sourceUrl || '');
  return { ok: true };
}

export async function historyPayload(bookId) {
  return { history: await getHistory(bookId) };
}

export async function checkBookPayload(bookId) {
  return {
    ...(await checkBookById(bookId, { notify: true })),
    diagnostics: diagnosticsPayload()
  };
}

export async function runChecksPayload(options = {}) {
  return runDueChecks({ notify: true, ...options });
}

export async function settingsPayload() {
  return {
    ...(await getSettingsSummary()),
    ...diagnosticsPayload()
  };
}

export async function importQueuePayload() {
  return getBookImportQueue();
}

export async function saveImportQueuePayload(body = {}) {
  if (body.append === true || body.mode === 'append') {
    return enqueueBookImportQueue(body.input || body.url || body.asin || body.inputs || body.text || body.urls || '');
  }

  return saveBookImportQueue(Array.isArray(body.inputs) ? body.inputs : body.text || body.urls || '');
}

export async function saveSettingsPayload(body = {}) {
  return { settings: await saveSettings(body) };
}

export async function webhooksPayload() {
  return getDiscordWebhooks();
}

export async function saveWebhooksPayload(body = {}) {
  return saveDiscordWebhooks(body.entries || body.webhooks || body.urls || []);
}

export async function testNotificationPayload() {
  return sendTestNotification();
}

function diagnosticsPayload() {
  return {
    priceProvider: process.env.PRICE_PROVIDER || 'amazon_html',
    keepaConfigured: Boolean(process.env.KEEPA_API_KEY)
  };
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
