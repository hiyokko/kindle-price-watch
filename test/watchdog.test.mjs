import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWatchdogTarget, workflowDispatchInputs } from '../scripts/check-watchdog.mjs';

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

test('watchdog dispatches the price-check workflow as a backup without force-all', () => {
  assert.deepEqual(workflowDispatchInputs({ cron: '54 6 * * *' }), {
    force_all: 'false',
    schedule_cron: '54 6 * * *',
    backup: 'true'
  });
});
