import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { requestSignal } from '../src/request-signal.mjs';

test('a phase timeout does not abort its parent and cleanup removes its listener', async () => {
  const parent = new AbortController();
  const phase = requestSignal(parent.signal, 10);
  await new Promise(resolve => phase.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(parent.signal.aborted, false);
  phase.cleanup();
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('parent cancellation propagates but cleanup detaches completed phases', () => {
  const parent = new AbortController();
  const active = requestSignal(parent.signal, 10000);
  const completed = requestSignal(parent.signal, 10000);
  completed.cleanup();
  parent.abort();
  assert.equal(active.signal.aborted, true);
  assert.equal(completed.signal.aborted, false);
  active.cleanup();
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  assert.equal(requestSignal(parent.signal, 0).signal.aborted, true);
});
