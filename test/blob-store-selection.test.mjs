import assert from 'node:assert/strict';
import test from 'node:test';

import { selectNewestBlobStore, selectNewestBlobStoreState } from '../src/store.mjs';

test('compressed store wins when it was written after the compatibility mirror', () => {
  const legacy = { pathname: 'store.json', uploadedAt: '2026-07-24T00:00:00.000Z' };
  const compressed = { pathname: 'store.json.gz', uploadedAt: '2026-07-24T00:00:01.000Z' };

  assert.equal(selectNewestBlobStore(compressed, legacy), compressed);
});

test('legacy store wins after an older deployment writes newer production data', () => {
  const compressed = { pathname: 'store.json.gz', uploadedAt: '2026-07-24T00:00:00.000Z' };
  const legacy = { pathname: 'store.json', uploadedAt: '2026-07-24T00:00:01.000Z' };

  assert.equal(selectNewestBlobStore(compressed, legacy), legacy);
});

test('compressed store wins a metadata tie', () => {
  const compressed = { pathname: 'store.json.gz' };
  const legacy = { pathname: 'store.json' };

  assert.equal(selectNewestBlobStore(compressed, legacy), compressed);
});

test('store revision wins over upload order during a two-blob write race', () => {
  const compressed = {
    compressed: true,
    store: { storeRevision: 4 },
    sourceMetadata: { uploadedAt: '2026-08-23T00:00:02.000Z' }
  };
  const legacy = {
    compressed: false,
    store: { storeRevision: 5 },
    sourceMetadata: { uploadedAt: '2026-08-23T00:00:01.000Z' }
  };

  assert.equal(selectNewestBlobStoreState(compressed, legacy), legacy);
});

test('upload order remains the fallback for equal store revisions', () => {
  const compressed = {
    compressed: true,
    store: { storeRevision: 5 },
    sourceMetadata: { uploadedAt: '2026-08-23T00:00:01.000Z' }
  };
  const legacy = {
    compressed: false,
    store: { storeRevision: 5 },
    sourceMetadata: { uploadedAt: '2026-08-23T00:00:02.000Z' }
  };

  assert.equal(selectNewestBlobStoreState(compressed, legacy), legacy);
});
