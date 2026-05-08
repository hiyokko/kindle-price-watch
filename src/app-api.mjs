import {
  addBooksFromInput,
  addBooksFromInputs,
  addSeriesImports,
  checkBookById,
  deleteAllBooks,
  deleteBook,
  deleteBooks,
  deleteSeries,
  getDiscordWebhooks,
  getHistory,
  getSettingsSummary,
  listBooks,
  runDueChecks,
  saveDiscordWebhooks,
  saveSettings,
  sendTestNotification
} from './checker.mjs';

export async function listBooksPayload() {
  return { books: await listBooks() };
}

export async function addBooksPayload(body = {}) {
  if (Array.isArray(body.seriesImports)) {
    return addSeriesImports(body.seriesImports, {
      fetchDetails: body.fetchDetails === true
    });
  }

  const inputs = Array.isArray(body.urls) ? body.urls : Array.isArray(body.inputs) ? body.inputs : null;
  if (inputs) {
    return addBooksFromInputs(inputs, {
      skipExternalFallback: body.skipExternalFallback === true,
      skipBackfill: body.skipBackfill === true
    });
  }

  return addBooksFromInput(body.url || body.asin || '');
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

export async function saveSettingsPayload(body = {}) {
  return { settings: await saveSettings(body) };
}

export async function webhooksPayload() {
  return getDiscordWebhooks();
}

export async function saveWebhooksPayload(body = {}) {
  return saveDiscordWebhooks(body.urls || []);
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
