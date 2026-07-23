import { getBlobSdk, hasBlobConfig } from './blob-client.mjs';

const payloadCaches = new Map();

export async function readBlobPayload(kind, storeEtag, options = {}) {
  if (!hasBlobConfig() || !storeEtag) return null;

  const pathname = blobPayloadPath(kind, storeEtag);
  const ifNoneMatch = String(options.ifNoneMatch || '').trim();
  const cached = payloadCaches.get(kind);

  if (cached?.metadata?.pathname === pathname && cached.expiresAt > Date.now()) {
    if (etagHeaderMatches(ifNoneMatch, cached.metadata.etag)) {
      return payloadResponse(304, cached.metadata, Buffer.alloc(0));
    }
    if (cached.body) {
      return payloadResponse(200, cached.metadata, Buffer.from(cached.body));
    }
  }

  const { get } = await getBlobSdk();
  const result = await get(pathname, {
    access: 'private',
    ifNoneMatch: ifNoneMatch || undefined
  });
  if (!result) return null;

  if (result.statusCode === 304) {
    const metadata = payloadMetadata(pathname, result.blob);
    setPayloadCache(kind, metadata, null);
    return payloadResponse(304, metadata, Buffer.alloc(0));
  }
  if (result.statusCode !== 200 || !result.stream) return null;

  const body = Buffer.from(await new Response(result.stream).arrayBuffer());
  const metadata = payloadMetadata(pathname, result.blob, body.length);
  setPayloadCache(kind, metadata, body);
  return payloadResponse(200, metadata, body);
}

export async function writeBlobPayload(kind, storeEtag, body) {
  if (!hasBlobConfig() || !storeEtag || !body) return null;

  const pathname = blobPayloadPath(kind, storeEtag);
  const bytes = Buffer.from(body);
  const { put } = await getBlobSdk();
  const result = await put(pathname, bytes, {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60 * 60 * 24 * 30
  });
  const metadata = payloadMetadata(pathname, result, bytes.length);
  setPayloadCache(kind, metadata, bytes);
  return metadata;
}

export async function pruneBlobPayloads(kinds = ['books', 'control'], options = {}) {
  if (!hasBlobConfig()) return { deleted: 0, retained: 0 };

  const keep = payloadRetention(options.keep);
  const { del, list } = await getBlobSdk();
  let deleted = 0;
  let retained = 0;

  for (const kind of kinds) {
    const blobs = await listAllPayloadBlobs(list, kind);
    blobs.sort((left, right) => new Date(right.uploadedAt || 0) - new Date(left.uploadedAt || 0));
    retained += Math.min(blobs.length, keep);

    const stale = blobs.slice(keep);
    if (stale.length === 0) continue;
    await del(stale.map((blob) => blob.url || blob.pathname).filter(Boolean));
    deleted += stale.length;
  }

  return { deleted, retained };
}

export function blobPayloadPath(kind, storeEtag) {
  const directory = blobStoreDirectory();
  const safeKind = sanitizePathSegment(kind) || 'payload';
  const key = sanitizePathSegment(normalizeEtag(storeEtag)) || 'unknown';
  return `${directory ? `${directory}/` : ''}${safeKind}-payloads/${key}.json.gz`;
}

async function listAllPayloadBlobs(list, kind) {
  const prefix = blobPayloadDirectory(kind);
  const blobs = [];
  let cursor;

  do {
    const page = await list({ prefix, limit: 1000, cursor });
    blobs.push(...(page.blobs || []));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return blobs;
}

function blobPayloadDirectory(kind) {
  const directory = blobStoreDirectory();
  const safeKind = sanitizePathSegment(kind) || 'payload';
  return `${directory ? `${directory}/` : ''}${safeKind}-payloads/`;
}

function payloadMetadata(pathname, blob = {}, fallbackSize = 0) {
  return {
    pathname,
    etag: blob?.etag || '',
    size: blob?.size || fallbackSize
  };
}

function payloadResponse(statusCode, metadata, body) {
  return {
    statusCode,
    etag: metadata.etag,
    body,
    pathname: metadata.pathname,
    size: metadata.size || body.length
  };
}

function setPayloadCache(kind, metadata, body) {
  payloadCaches.set(kind, {
    expiresAt: Date.now() + payloadMemoryCacheMs(),
    metadata,
    body: body ? Buffer.from(body) : null
  });
}

function blobStoreDirectory() {
  const storePath = process.env.BLOB_STORE_PATH || 'kindle-price-watch/store.json';
  const index = storePath.lastIndexOf('/');
  return index === -1 ? '' : storePath.slice(0, index);
}

function sanitizePathSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

function etagHeaderMatches(header, etag) {
  if (!header || !etag) return false;
  const normalizedEtag = normalizeEtag(etag);
  return String(header)
    .split(',')
    .map((item) => normalizeEtag(item.trim()))
    .includes(normalizedEtag);
}

function normalizeEtag(value) {
  return String(value || '').replace(/^W\//, '').replace(/^"|"$/g, '');
}

function payloadRetention(value) {
  const configured = Number(value ?? process.env.BLOB_DERIVED_PAYLOAD_RETENTION);
  if (!Number.isFinite(configured)) return 16;
  return Math.min(200, Math.max(2, Math.round(configured)));
}

function payloadMemoryCacheMs() {
  const configured = Number(
    process.env.BLOB_DERIVED_PAYLOAD_MEMORY_CACHE_MS ??
      process.env.BLOB_BOOK_LIST_PAYLOAD_MEMORY_CACHE_MS
  );
  return Number.isFinite(configured) && configured >= 0 ? Math.round(configured) : 15000;
}
