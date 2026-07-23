import assert from 'node:assert/strict';
import test from 'node:test';

import { blobPayloadPath } from '../src/blob-payload-store.mjs';

test('derived payload paths are immutable and scoped beside the main store', () => {
  const previousPath = process.env.BLOB_STORE_PATH;
  process.env.BLOB_STORE_PATH = 'kindle-price-watch/store.json';

  try {
    assert.equal(
      blobPayloadPath('control', 'W/"store-etag:1"'),
      'kindle-price-watch/control-payloads/store-etag_1.json.gz'
    );
  } finally {
    if (previousPath == null) delete process.env.BLOB_STORE_PATH;
    else process.env.BLOB_STORE_PATH = previousPath;
  }
});
