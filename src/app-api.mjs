import { gzipSync } from 'node:zlib';
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
  listBooksWithStoreMetadata,
  runDueChecks,
  saveDiscordWebhooks,
  saveBookImportQueue,
  saveSettings,
  sendTestNotification
} from './checker.mjs';
import { bookListPayload, compactBooksPayload } from './book-list-payload.mjs';
import { buildBodyResponse, buildPrecompressedGzipResponse, requestAcceptsEncoding } from './http-response.mjs';
import {
  hasBlobConfig,
  readBlobBookListPayload,
  readStoreHeadMetadata,
  writeBlobBookListPayload
} from './store.mjs';

export async function listBooksPayload() {
  return bookListPayload(await listBooks());
}

export async function listBooksPayloadResponse(req) {
  const cacheControl = 'private, no-cache, max-age=0';
  const acceptsGzip = requestAcceptsEncoding(req, 'gzip');

  if (acceptsGzip && hasBlobConfig()) {
    const cached = await readCurrentBookListPayloadBlob(req);
    if (cached) {
      return buildPrecompressedGzipResponse(cached.statusCode, cached.body || Buffer.alloc(0), {
        etag: cached.etag,
        cacheControl
      });
    }
  }

  const { payload, storeEtag } = await listBooksPayloadWithMetadata();
  const body = Buffer.from(JSON.stringify(payload));

  if (acceptsGzip && storeEtag && hasBlobConfig()) {
    const gzipBody = gzipSync(body);
    const saved = await writeBlobBookListPayload(storeEtag, gzipBody).catch((error) => {
      console.error('Failed to refresh book list payload blob', error);
      return null;
    });
    if (saved?.etag) {
      return buildPrecompressedGzipResponse(200, gzipBody, {
        etag: saved.etag,
        cacheControl
      });
    }
  }

  return buildBodyResponse(200, body, {
    req,
    etag: true,
    gzip: true,
    cacheControl
  });
}

async function readCurrentBookListPayloadBlob(req) {
  const storeHead = await readStoreHeadMetadata({ force: true }).catch((error) => {
    console.error('Failed to read store metadata for book list payload', error);
    return null;
  });
  if (!storeHead?.etag) return null;

  return readBlobBookListPayload(storeHead.etag, {
    ifNoneMatch: req?.headers?.['if-none-match'] || ''
  }).catch((error) => {
    console.error('Failed to read book list payload blob', error);
    return null;
  });
}

async function listBooksPayloadWithMetadata() {
  const { books, storeEtag } = await listBooksWithStoreMetadata();
  return {
    payload: bookListPayload(books),
    storeEtag
  };
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

export { compactBooksPayload };
