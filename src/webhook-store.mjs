import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getBlobSdk, hasBlobConfig } from './blob-client.mjs';
import { activeWebhookUrls, normalizeWebhookEntries } from './webhook-config.mjs';

const dataDir = path.join(process.cwd(), 'data');
const localWebhookPath = path.join(dataDir, 'webhooks.json');

let writeQueue = Promise.resolve();
let blobWebhookCache = {
  expiresAt: 0,
  store: null,
  promise: null
};

export async function readWebhookStore() {
  if (hasBlobConfig()) return readBlobWebhookStore();
  await ensureLocalWebhookDir();

  try {
    const raw = await fs.readFile(localWebhookPath, 'utf8');
    return normalizeWebhookStore(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeWebhookStore({});
    throw error;
  }
}

export async function writeWebhookStore(entries) {
  const discordWebhooks = normalizeWebhookEntries(entries);
  const next = normalizeWebhookStore({
    discordWebhooks,
    discordWebhookUrls: activeWebhookUrls(discordWebhooks),
    updatedAt: new Date().toISOString()
  });

  if (hasBlobConfig()) {
    writeQueue = writeQueue.then(async () => {
      await writeBlobWebhookStore(next);
      return next;
    });
    return writeQueue;
  }

  writeQueue = writeQueue.then(async () => {
    await ensureLocalWebhookDir();
    const tmpPath = `${localWebhookPath}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2));
    await fs.rename(tmpPath, localWebhookPath);
    return next;
  });
  return writeQueue;
}

function normalizeWebhookStore(value = {}) {
  const hasEntries =
    Array.isArray(value.discordWebhooks) ||
    Array.isArray(value.discordWebhookUrls) ||
    typeof value.discordWebhookUrls === 'string';
  const discordWebhooks = hasEntries
    ? normalizeWebhookEntries(value.discordWebhooks ?? value.discordWebhookUrls)
    : null;

  return {
    version: 2,
    discordWebhooks,
    discordWebhookUrls: discordWebhooks ? activeWebhookUrls(discordWebhooks) : null,
    updatedAt: value.updatedAt || ''
  };
}

async function ensureLocalWebhookDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function readBlobWebhookStore() {
  const now = Date.now();
  if (blobWebhookCache.store && blobWebhookCache.expiresAt > now) return cloneWebhookStore(blobWebhookCache.store);
  if (blobWebhookCache.promise) return cloneWebhookStore(await blobWebhookCache.promise);

  const promise = fetchBlobWebhookStore();
  blobWebhookCache.promise = promise;
  try {
    const store = await promise;
    setBlobWebhookCache(store);
    return cloneWebhookStore(store);
  } finally {
    if (blobWebhookCache.promise === promise) blobWebhookCache.promise = null;
  }
}

async function fetchBlobWebhookStore() {
  const { get } = await getBlobSdk();
  let result;
  try {
    result = await get(blobWebhookPath(), { access: 'private', useCache: false });
  } catch (error) {
    if (error.status === 404 || error.statusCode === 404) return normalizeWebhookStore({});
    throw error;
  }

  if (result?.statusCode !== 200 || !result.stream) return normalizeWebhookStore({});

  const raw = await new Response(result.stream).text();
  return normalizeWebhookStore(JSON.parse(raw));
}

async function writeBlobWebhookStore(store) {
  const { put } = await getBlobSdk();
  await put(blobWebhookPath(), JSON.stringify(store, null, 2), {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0
  });
  setBlobWebhookCache(store);
}

function setBlobWebhookCache(store) {
  blobWebhookCache = {
    expiresAt: Date.now() + blobWebhookMemoryCacheMs(),
    store: cloneWebhookStore(store),
    promise: null
  };
}

function cloneWebhookStore(store) {
  return normalizeWebhookStore(JSON.parse(JSON.stringify(store || {})));
}

function blobWebhookPath() {
  return process.env.WEBHOOK_STORE_PATH || 'kindle-price-watch/webhooks.json';
}

function blobWebhookMemoryCacheMs() {
  const value = Number(process.env.BLOB_WEBHOOK_MEMORY_CACHE_MS ?? process.env.BLOB_STORE_MEMORY_CACHE_MS);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 15000;
}
