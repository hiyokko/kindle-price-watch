import { promises as fs } from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data');
const storePath = path.join(dataDir, 'store.json');
const blobStorePath = process.env.BLOB_STORE_PATH || 'kindle-price-watch/store.json';

const defaultStore = {
  version: 1,
  settings: {
    notificationThreshold: 10,
    checkIntervalHours: 24,
    batchSize: 50,
    notifyOnPriceDrop: true,
    notifyOnBestEver: true,
    discordWebhookUrls: null
  },
  books: [],
  priceHistory: [],
  notifications: [],
  automation: {
    lastCronStartedAt: '',
    lastCronFinishedAt: '',
    lastCronChecked: 0,
    lastCronRemainingDue: 0,
    lastCronStoppedByRuntimeLimit: false,
    lastCronError: ''
  },
  checkCursor: {
    lastBookId: '',
    lastAsin: '',
    lastTitle: '',
    checkedAt: ''
  }
};

let writeQueue = Promise.resolve();
let blobSdkPromise;

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify(defaultStore, null, 2));
  }
}

function mergeStore(store) {
  return {
    ...defaultStore,
    ...store,
    settings: {
      ...defaultStore.settings,
      ...(store.settings || {})
    },
    books: Array.isArray(store.books) ? store.books : [],
    priceHistory: Array.isArray(store.priceHistory) ? store.priceHistory : [],
    notifications: Array.isArray(store.notifications) ? store.notifications : [],
    automation: normalizeAutomation(store.automation),
    checkCursor: normalizeCheckCursor(store.checkCursor)
  };
}

export async function readStore() {
  if (hasSupabaseConfig()) {
    return readSupabaseStore();
  }

  if (hasBlobConfig()) {
    return readBlobStore();
  }

  await ensureStore();
  const raw = await fs.readFile(storePath, 'utf8');
  return mergeStore(JSON.parse(raw));
}

export async function updateStore(mutator) {
  if (hasSupabaseConfig()) {
    return updateSupabaseStore(mutator);
  }

  if (hasBlobConfig()) {
    return updateBlobStore(mutator);
  }

  writeQueue = writeQueue.then(async () => {
    const store = await readStore();
    const next = mergeStore(await mutator(store));
    const tmpPath = `${storePath}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2));
    await fs.rename(tmpPath, storePath);
    return next;
  });

  return writeQueue;
}

export function publicBook(book) {
  return {
    id: book.id,
    asin: book.asin,
    title: book.title,
    author: publicMetadataText(book.author),
    publisher: publicMetadataText(book.publisher),
    seriesKey: book.seriesKey || '',
    seriesName: book.seriesName,
    volume: book.volume,
    seriesExpectedCount: book.seriesExpectedCount || '',
    sourceUrl: book.sourceUrl || '',
    importMode: book.importMode || 'single',
    imageUrl: book.imageUrl,
    amazonUrl: book.amazonUrl,
    currentPrice: book.currentPrice,
    currentPoints: book.currentPoints,
    effectivePrice: book.effectivePrice,
    listPrice: book.listPrice,
    lowestPrice: book.lowestPrice,
    lowestEffectivePrice: book.lowestEffectivePrice,
    previousEffectivePrice: book.previousEffectivePrice,
    lastCheckedAt: book.lastCheckedAt,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    lastError: book.lastError,
    provider: book.provider
  };
}

function publicMetadataText(value) {
  const text = String(value || '')
    .replace(/^フォロー,\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length > 120) return '';
  if (/function|P\.when|A\.declarative|window\.ue|var\s+/i.test(text)) return '';
  return text;
}

function normalizeCheckCursor(cursor) {
  return {
    ...defaultStore.checkCursor,
    ...(cursor || {})
  };
}

function normalizeAutomation(automation) {
  return {
    ...defaultStore.automation,
    ...(automation || {})
  };
}

function hasSupabaseConfig() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function hasBlobConfig() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function readBlobStore() {
  const { store } = await readBlobStoreWithMetadata();
  return store;
}

async function updateBlobStore(mutator) {
  writeQueue = writeQueue.then(async () => {
    const { store } = await readBlobStoreWithMetadata();
    const next = mergeStore(await mutator(store));
    await writeBlobStore(next);
    return next;
  });

  return writeQueue;
}

async function readBlobStoreWithMetadata() {
  const { get } = await getBlobSdk();
  const result = await get(blobStorePath, { access: 'private', useCache: false });

  if (result?.statusCode !== 200 || !result.stream) {
    return { store: mergeStore(defaultStore), etag: '' };
  }

  const raw = await new Response(result.stream).text();
  return {
    store: mergeStore(JSON.parse(raw)),
    etag: result.blob?.etag || ''
  };
}

async function writeBlobStore(store) {
  const { put } = await getBlobSdk();
  await put(blobStorePath, JSON.stringify(store, null, 2), {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0
  });
}

async function getBlobSdk() {
  blobSdkPromise ||= import('@vercel/blob');
  return blobSdkPromise;
}

async function readSupabaseStore() {
  const rows = await supabaseFetch('/rest/v1/app_state?key=eq.store&select=value');
  if (Array.isArray(rows) && rows[0]?.value) {
    return mergeStore(rows[0].value);
  }

  await writeSupabaseStore(defaultStore);
  return mergeStore(defaultStore);
}

async function updateSupabaseStore(mutator) {
  const store = await readSupabaseStore();
  const next = mergeStore(await mutator(store));
  await writeSupabaseStore(next);
  return next;
}

async function writeSupabaseStore(store) {
  await supabaseFetch('/rest/v1/app_state?on_conflict=key', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      key: 'store',
      value: store,
      updated_at: new Date().toISOString()
    })
  });
}

async function supabaseFetch(pathname, options = {}) {
  const baseUrl = process.env.SUPABASE_URL.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Supabase HTTP ${response.status}: ${body.slice(0, 160)}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
