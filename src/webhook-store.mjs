import { promises as fs } from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data');
const localWebhookPath = path.join(dataDir, 'webhooks.json');
const blobWebhookPath = process.env.WEBHOOK_STORE_PATH || 'kindle-price-watch/webhooks.json';

let writeQueue = Promise.resolve();
let blobSdkPromise;

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

export async function writeWebhookStore(urls) {
  const next = normalizeWebhookStore({
    discordWebhookUrls: Array.isArray(urls) ? urls : [],
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
  return {
    version: 1,
    discordWebhookUrls: Array.isArray(value.discordWebhookUrls) ? value.discordWebhookUrls : null,
    updatedAt: value.updatedAt || ''
  };
}

async function ensureLocalWebhookDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

function hasBlobConfig() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function readBlobWebhookStore() {
  const { get } = await getBlobSdk();
  let result;
  try {
    result = await get(blobWebhookPath, { access: 'private', useCache: false });
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
  await put(blobWebhookPath, JSON.stringify(store, null, 2), {
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
