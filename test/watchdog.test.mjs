import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  classifyPriceCheckRuns,
  parseControlPayload,
  selectWatchdogTarget,
  workflowDispatchInputs
} from '../scripts/check-watchdog.mjs';

test('watchdog targets the 15:54 JST window after the minimum lag', () => {
  const target = selectWatchdogTarget(new Date('2026-05-18T07:20:00.000Z').getTime(), {
    minLagMinutes: 20,
    maxLagMinutes: 360
  });

  assert.equal(target.label, '15:54 JST');
  assert.equal(target.cron, '54 6 * * *');
  assert.equal(target.skipReason, undefined);
});

test('watchdog waits until the target window has enough lag', () => {
  const target = selectWatchdogTarget(new Date('2026-05-18T07:05:00.000Z').getTime(), {
    minLagMinutes: 20,
    maxLagMinutes: 360
  });

  assert.equal(target.label, '15:54 JST');
  assert.equal(target.skipReason, 'too_early');
});

test('watchdog does not catch up a window after the max lag', () => {
  const target = selectWatchdogTarget(new Date('2026-05-18T13:00:00.000Z').getTime(), {
    minLagMinutes: 20,
    maxLagMinutes: 360
  });

  assert.equal(target.label, '15:54 JST');
  assert.equal(target.skipReason, 'too_old');
});

test('watchdog targets the 03:54 JST window in the morning', () => {
  const target = selectWatchdogTarget(new Date('2026-05-17T19:20:00.000Z').getTime(), {
    minLagMinutes: 20,
    maxLagMinutes: 360
  });

  assert.equal(target.label, '03:54 JST');
  assert.equal(target.cron, '54 18 * * *');
  assert.equal(target.skipReason, undefined);
});

test('watchdog catches a delayed pre-window schedule after the morning boundary', () => {
  const target = selectWatchdogTarget(new Date('2026-06-02T19:04:38.000Z').getTime(), {
    minLagMinutes: 5,
    maxLagMinutes: 360
  });

  assert.equal(target.label, '03:54 JST');
  assert.equal(target.cron, '54 18 * * *');
  assert.equal(target.skipReason, undefined);
});

test('watchdog dispatches the price-check workflow as a backup without force-all', () => {
  assert.deepEqual(workflowDispatchInputs({ cron: '54 6 * * *' }), {
    force_all: 'false',
    schedule_cron: '54 6 * * *',
    backup: 'true'
  });
});

test('watchdog preserves healthy active runs across code revisions and expires only overlong runs', () => {
  const result = classifyPriceCheckRuns([
    {
      id: 1,
      status: 'in_progress',
      head_sha: 'old-sha',
      run_started_at: '2026-09-02T04:43:48.000Z'
    },
    {
      id: 2,
      status: 'pending',
      head_sha: 'old-sha',
      created_at: '2026-09-02T06:29:05.000Z'
    },
    {
      id: 3,
      status: 'queued',
      head_sha: 'current-sha',
      created_at: '2026-09-02T06:30:00.000Z'
    },
    {
      id: 4,
      status: 'in_progress',
      head_sha: 'old-sha',
      run_started_at: '2026-09-01T23:00:00.000Z'
    },
    { id: 5, status: 'completed', head_sha: 'old-sha' }
  ], 'current-sha', {
    now: new Date('2026-09-02T07:00:00.000Z').getTime(),
    staleAfterMinutes: 360
  });

  assert.deepEqual(result.activeRuns.map((run) => run.id), [1, 2, 3]);
  assert.deepEqual(result.activeCurrentRuns.map((run) => run.id), [3]);
  assert.deepEqual(result.activeOtherRevisionRuns.map((run) => run.id), [1, 2]);
  assert.deepEqual(result.staleRuns.map((run) => run.id), [4]);
});

test('watchdog reads automation state from the small gzip control payload', () => {
  const payload = {
    settings: { batchSize: 50 },
    automation: {
      lastCronExecutionBoundaryAt: '2026-05-18T06:54:00.000Z',
      lastCronError: ''
    }
  };

  assert.deepEqual(parseControlPayload(gzipSync(JSON.stringify(payload))), payload);
});
