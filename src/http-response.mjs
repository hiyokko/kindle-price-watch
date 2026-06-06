import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export function buildBodyResponse(status, body, options = {}) {
  let responseBody = body;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': options.cacheControl || 'no-store'
  };
  if (options.contentType) headers['Content-Type'] = options.contentType;
  if (options.gzip) headers.Vary = appendHeaderValue(headers.Vary, 'Accept-Encoding');
  if (options.etag) {
    const etag = responseEtag(body, { weak: Boolean(options.gzip) });
    headers.ETag = etag;
    if (status === 200 && requestEtagMatches(options.req, etag)) {
      return { status: 304, headers, body: Buffer.alloc(0) };
    }
  }
  if (shouldGzipBody(status, body, options.req, options)) {
    responseBody = gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  return { status, headers, body: responseBody };
}

function shouldGzipBody(status, body, req, options = {}) {
  if (!options.gzip || status !== 200 || body.length < gzipMinBytes()) return false;
  return requestAcceptsEncoding(req, 'gzip');
}

function requestAcceptsEncoding(req, encoding) {
  const value = String(req?.headers?.['accept-encoding'] || '').toLowerCase();
  return value
    .split(',')
    .map((item) => item.trim().split(';')[0])
    .includes(encoding);
}

function gzipMinBytes() {
  return 1024;
}

function appendHeaderValue(value, next) {
  const values = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === next.toLowerCase())) values.push(next);
  return values.join(', ');
}

function responseEtag(body, options = {}) {
  const value = `"${createHash('sha256').update(body).digest('base64url')}"`;
  return options.weak ? `W/${value}` : value;
}

function requestEtagMatches(req, etag) {
  const value = String(req?.headers?.['if-none-match'] || '');
  if (!value) return false;
  const normalizedEtag = normalizeEtag(etag);
  return value
    .split(',')
    .map((item) => normalizeEtag(item.trim()))
    .includes(normalizedEtag);
}

function normalizeEtag(value) {
  return String(value || '').replace(/^W\//, '');
}
