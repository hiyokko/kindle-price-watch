import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { buildBodyResponse } from '../src/http-response.mjs';

test('large API responses can be sent as gzip with weak ETag and Vary', () => {
  const body = Buffer.from(JSON.stringify({ books: [{ title: 'book'.repeat(400) }] }));
  const response = buildBodyResponse(200, body, {
    req: { headers: { 'accept-encoding': 'br, gzip' } },
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'private, no-cache, max-age=0',
    etag: true,
    gzip: true
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Encoding'], 'gzip');
  assert.equal(response.headers.Vary, 'Accept-Encoding');
  assert.match(response.headers.ETag, /^W\//);
  assert.deepEqual(JSON.parse(gunzipSync(response.body).toString('utf8')), JSON.parse(body.toString('utf8')));
});

test('gzip API responses still return 304 before recompressing matching ETags', () => {
  const body = Buffer.from(JSON.stringify({ books: [{ title: 'book'.repeat(400) }] }));
  const first = buildBodyResponse(200, body, {
    req: { headers: { 'accept-encoding': 'gzip' } },
    etag: true,
    gzip: true
  });
  const second = buildBodyResponse(200, body, {
    req: {
      headers: {
        'accept-encoding': 'gzip',
        'if-none-match': first.headers.ETag
      }
    },
    etag: true,
    gzip: true
  });

  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0);
  assert.equal(second.headers.ETag, first.headers.ETag);
  assert.equal(second.headers['Content-Encoding'], undefined);
  assert.equal(second.headers.Vary, 'Accept-Encoding');
});

test('gzip is skipped when the client does not advertise support', () => {
  const body = Buffer.from(JSON.stringify({ books: [{ title: 'book'.repeat(400) }] }));
  const response = buildBodyResponse(200, body, {
    req: { headers: {} },
    etag: true,
    gzip: true
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Encoding'], undefined);
  assert.equal(response.body, body);
  assert.equal(response.headers.Vary, 'Accept-Encoding');
});
