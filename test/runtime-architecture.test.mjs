import assert from 'node:assert/strict';
import test from 'node:test';

import { createSerialTaskQueue } from '../src/serial-task-queue.mjs';
import {
  blobWriteConflictAttempts,
  isBlobWriteConflict,
  isPromiseLike,
  nextStoreRevision
} from '../src/store-update-policy.mjs';
import { shouldPruneDerivedPayloads } from '../src/store-payload-sync.mjs';

test('serial task queue continues after a failed write', async () => {
  const enqueue = createSerialTaskQueue();
  const order = [];

  await assert.rejects(
    enqueue(async () => {
      order.push('failed');
      throw new Error('write failed');
    }),
    /write failed/
  );

  const result = await enqueue(async () => {
    order.push('recovered');
    return 42;
  });

  assert.equal(result, 42);
  assert.deepEqual(order, ['failed', 'recovered']);
});

test('store update policy increments revisions and recognizes Blob conflicts', () => {
  assert.equal(nextStoreRevision({ books: [] }, 7).storeRevision, 8);
  assert.equal(isPromiseLike(Promise.resolve()), true);
  assert.equal(isPromiseLike({}), false);
  assert.equal(isBlobWriteConflict({ name: 'BlobPreconditionFailedError' }), true);
  assert.equal(isBlobWriteConflict({ statusCode: 412 }), true);
  assert.equal(isBlobWriteConflict(new Error('network error')), false);
  assert.equal(blobWriteConflictAttempts('20'), 10);
  assert.equal(blobWriteConflictAttempts('invalid'), 3);
});

test('derived payload cleanup runs once per configured revision interval', () => {
  assert.equal(shouldPruneDerivedPayloads(0), false);
  assert.equal(shouldPruneDerivedPayloads(7), false);
  assert.equal(shouldPruneDerivedPayloads(8), true);
  assert.equal(shouldPruneDerivedPayloads(16), true);
  assert.equal(shouldPruneDerivedPayloads(6, { interval: 3 }), true);
});
