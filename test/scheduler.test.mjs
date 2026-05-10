import assert from 'node:assert/strict';
import test from 'node:test';

import { cronWindowCompletionState, resolveCronScheduleIntent } from '../src/checker.mjs';

test('delayed evening backup still targets the 15:54 JST execution window', () => {
  const now = Date.UTC(2026, 4, 10, 13, 21); // 2026-05-10 22:21 JST
  const intent = resolveCronScheduleIntent('7 7 * * *', now);

  assert.equal(intent.backup, true);
  assert.equal(intent.executionBoundaryAt, '2026-05-10T06:54:00.000Z');
  assert.equal(intent.nextExecutionBoundaryAt, '2026-05-10T18:54:00.000Z');
  assert.equal(intent.stale, false);
});

test('a scheduled run is stale after the next execution window begins', () => {
  const now = Date.UTC(2026, 4, 10, 19, 0); // 2026-05-11 04:00 JST
  const intent = resolveCronScheduleIntent('7 7 * * *', now);

  assert.equal(intent.executionBoundaryAt, '2026-05-10T06:54:00.000Z');
  assert.equal(intent.nextExecutionBoundaryAt, '2026-05-10T18:54:00.000Z');
  assert.equal(intent.stale, true);
});

test('completion skip requires the same execution boundary when the boundary is recorded', () => {
  const state = cronWindowCompletionState(
    {
      lastCronExecutionBoundaryAt: '2026-05-10T06:54:00.000Z',
      lastCronStartedAt: '2026-05-10T07:00:00.000Z',
      lastCronFinishedAt: '2026-05-10T10:00:00.000Z',
      lastCronError: ''
    },
    Date.UTC(2026, 4, 10, 18, 54)
  );

  assert.equal(state.shouldSkip, false);
});

test('completion skip allows backup retries to no-op after the same window completed', () => {
  const state = cronWindowCompletionState(
    {
      lastCronExecutionBoundaryAt: '2026-05-10T06:54:00.000Z',
      lastCronStartedAt: '2026-05-10T07:00:00.000Z',
      lastCronFinishedAt: '2026-05-10T10:00:00.000Z',
      lastCronError: ''
    },
    Date.UTC(2026, 4, 10, 6, 54)
  );

  assert.equal(state.shouldSkip, true);
  assert.equal(state.skipDetail, 'successful_completion');
});
