import { gzipSync } from 'node:zlib';
import {
  enqueueBookImportQueue,
  getDiscordWebhooks,
  getBookImportQueue,
  getSettingsSummary,
  saveDiscordWebhooks,
  saveBookImportQueue,
  saveSettings,
  sendTestNotification,
  settingsSummaryFromStore
} from './control-service.mjs';
import { bookListPayload, bootstrapPayload, compactBooksPayload } from './book-list-payload.mjs';
import { buildBodyResponse, buildPrecompressedGzipResponse, requestAcceptsEncoding } from './http-response.mjs';
import {
  hasBlobConfig,
  readBlobBootstrapPayload,
  readBlobControlPayload,
  readStoreHeadMetadata,
  writeBlobBootstrapPayload,
  writeBlobControlPayload
} from './store.mjs';

let checkerModulePromise;

export async function listBooksPayload() {
  const { listBooks } = await checkerModule();
  return bookListPayload(await listBooks());
}

export async function listBooksPayloadResponse(req) {
  return bootstrapPayloadResponse(req);
}

export async function bootstrapPayloadResponse(req) {
  return derivedJsonPayloadResponse(req, {
    label: 'bootstrap',
    readBlob: readBlobBootstrapPayload,
    writeBlob: writeBlobBootstrapPayload,
    load: bootstrapPayloadWithMetadata
  });
}

export async function settingsPayloadResponse(req) {
  return derivedJsonPayloadResponse(req, {
    label: 'control',
    readBlob: readBlobControlPayload,
    writeBlob: writeBlobControlPayload,
    load: async () => ({
      payload: await settingsPayload(),
      storeEtag: (await readStoreHeadMetadata()).etag
    })
  });
}

async function derivedJsonPayloadResponse(req, options) {
  const cacheControl = 'private, no-cache, max-age=0';
  const acceptsGzip = requestAcceptsEncoding(req, 'gzip');

  if (acceptsGzip && hasBlobConfig()) {
    const cached = await readCurrentPayloadBlob(req, options.readBlob, options.label);
    if (cached) {
      return buildPrecompressedGzipResponse(cached.statusCode, cached.body || Buffer.alloc(0), {
        etag: cached.etag,
        cacheControl
      });
    }
  }

  const { payload, storeEtag } = await options.load();
  const body = Buffer.from(JSON.stringify(payload));
  if (acceptsGzip && storeEtag && hasBlobConfig()) {
    const gzipBody = gzipSync(body);
    const saved = await options.writeBlob(storeEtag, gzipBody).catch((error) => {
      console.error(`Failed to refresh ${options.label} payload blob`, error);
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

async function readCurrentPayloadBlob(req, reader, label) {
  const storeHead = await readStoreHeadMetadata().catch((error) => {
    console.error(`Failed to read store metadata for ${label} payload`, error);
    return null;
  });
  if (!storeHead?.etag) return null;

  return reader(storeHead.etag, {
    ifNoneMatch: req?.headers?.['if-none-match'] || ''
  }).catch((error) => {
    console.error(`Failed to read ${label} payload blob`, error);
    return null;
  });
}

async function bootstrapPayloadWithMetadata() {
  const { listBooksWithStoreMetadata } = await checkerModule();
  const { books, storeEtag, store } = await listBooksWithStoreMetadata({ includeStore: true });
  const webhooks = await getDiscordWebhooks({ store });
  return {
    payload: bootstrapPayload(books, settingsSummaryFromStore(store, webhooks)),
    storeEtag
  };
}

export async function addBooksPayload(body = {}) {
  if (Array.isArray(body.seriesImports)) {
    const { addSeriesImports } = await checkerModule();
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
  const { deleteAllBooks, deleteBooks } = await checkerModule();
  return body.all ? deleteAllBooks() : deleteBooks(body.ids || []);
}

export async function deleteBookPayload(id) {
  const { deleteBook } = await checkerModule();
  await deleteBook(id);
  return { ok: true };
}

export async function deleteSeriesPayload(body = {}) {
  const { deleteSeries } = await checkerModule();
  await deleteSeries(body.seriesKey || '', body.sourceUrl || '');
  return { ok: true };
}

export async function historyPayload(bookId) {
  const { getHistory } = await checkerModule();
  return { history: await getHistory(bookId) };
}

export async function checkBookPayload(bookId) {
  const { checkBookById } = await checkerModule();
  return {
    ...(await checkBookById(bookId, { notify: true })),
    diagnostics: diagnosticsPayload()
  };
}

export async function runChecksPayload(options = {}) {
  const { runDueChecks } = await checkerModule();
  return runDueChecks({ notify: true, ...options });
}

export async function settingsPayload() {
  return getSettingsSummary();
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

function checkerModule() {
  checkerModulePromise ||= import('./checker.mjs');
  return checkerModulePromise;
}

export { compactBooksPayload };
