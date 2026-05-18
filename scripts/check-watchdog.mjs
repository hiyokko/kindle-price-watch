import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadEnv } from '../src/env.mjs';
import { cronWindowCompletionState, recordCronRun, resolveCronScheduleIntent, runDueChecks } from '../src/checker.mjs';
import { readStore } from '../src/store.mjs';

const EXECUTION_WINDOWS = [
  { label: '03:54 JST', cron: '54 18 * * *', hour: 3, minute: 54 },
  { label: '15:54 JST', cron: '54 6 * * *', hour: 15, minute: 54 }
];

if (isMainModule()) {
  await main();
}

async function main() {
  loadEnv();
  validateActionEnvironment();

  const startedAt = Date.now();
  const scriptStartedAt = new Date(startedAt).toISOString();
  const hardTimeoutMs = checkHardTimeoutMs();
  const target = selectWatchdogTarget(startedAt, {
    minLagMinutes: readNumberEnv('CHECK_WATCHDOG_MIN_LAG_MINUTES', 20),
    maxLagMinutes: readNumberEnv('CHECK_WATCHDOG_MAX_LAG_MINUTES', 360)
  });

  if (!target) {
    console.log(JSON.stringify({
      skipped: true,
      reason: 'no_watchdog_target'
    }, null, 2));
    return;
  }

  if (target.skipReason) {
    console.log(JSON.stringify({
      skipped: true,
      reason: target.skipReason,
      target
    }, null, 2));
    return;
  }

  const scheduleIntent = resolveCronScheduleIntent(target.cron, startedAt);
  if (!scheduleIntent || scheduleIntent.stale) {
    console.log(JSON.stringify({
      skipped: true,
      reason: scheduleIntent?.stale ? 'stale_schedule' : 'unresolved_schedule',
      target,
      scheduleIntent
    }, null, 2));
    return;
  }

  const store = await readStore();
  const completion = cronWindowCompletionState(store.automation, scheduleIntent.executionBoundaryMs);
  if (completion.shouldSkip) {
    console.log(JSON.stringify({
      skipped: true,
      reason: 'target_window_completed',
      target,
      completion
    }, null, 2));
    return;
  }

  const forcedExitState = { recording: false };
  const watchdog = hardTimeoutMs > 0
    ? setTimeout(() => {
        void recordForcedExit('CHECK_HARD_TIMEOUT_MS elapsed', 124, {
          hardTimeoutMs,
          scriptStartedAt,
          scheduleIntent,
          forcedExitState
        });
      }, hardTimeoutMs)
    : null;

  process.once('SIGTERM', () => {
    void recordForcedExit('SIGTERM received', 143, {
      scriptStartedAt,
      scheduleIntent,
      forcedExitState
    });
  });

  try {
    const result = await runDueChecks({
      notify: true,
      source: 'cron',
      backup: true,
      scheduleCron: target.cron
    });
    console.log(JSON.stringify({
      watchdog: true,
      target,
      result
    }, null, 2));
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

export function selectWatchdogTarget(now = Date.now(), options = {}) {
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) return null;

  const minLagMs = Math.max(0, Math.round(Number(options.minLagMinutes ?? 20) || 0)) * 60 * 1000;
  const maxLagMs = Math.max(minLagMs, Math.round(Number(options.maxLagMinutes ?? 360) || 0) * 60 * 1000);
  const boundary = latestExecutionBoundary(nowMs);
  if (!boundary) return null;

  const lagMs = nowMs - boundary.boundaryMs;
  const target = {
    label: boundary.label,
    cron: boundary.cron,
    executionBoundaryAt: new Date(boundary.boundaryMs).toISOString(),
    lagMinutes: Math.floor(lagMs / 60000)
  };

  if (lagMs < minLagMs) {
    return {
      ...target,
      skipReason: 'too_early'
    };
  }

  if (lagMs > maxLagMs) {
    return {
      ...target,
      skipReason: 'too_old'
    };
  }

  return target;
}

function latestExecutionBoundary(nowMs) {
  const jstStart = jstDayStartUtcMs(nowMs);
  const dayMs = 24 * 60 * 60 * 1000;
  const candidates = [];

  for (const dayOffset of [1, 0]) {
    for (const window of EXECUTION_WINDOWS) {
      const boundaryMs = jstStart - dayOffset * dayMs + window.hour * 60 * 60 * 1000 + window.minute * 60 * 1000;
      if (boundaryMs <= nowMs) candidates.push({ ...window, boundaryMs });
    }
  }

  return candidates.sort((left, right) => right.boundaryMs - left.boundaryMs)[0] || null;
}

function jstDayStartUtcMs(timestamp) {
  const dayMs = 24 * 60 * 60 * 1000;
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  return Math.floor((Number(timestamp) + jstOffsetMs) / dayMs) * dayMs - jstOffsetMs;
}

function validateActionEnvironment() {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  if (!token) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not set. Add the raw Vercel Blob Read/Write Token to GitHub repository Secrets as BLOB_READ_WRITE_TOKEN.'
    );
  }

  const [provider, product, permission, storeId] = token.split('_');
  if (provider !== 'vercel' || product !== 'blob' || permission !== 'rw' || !storeId) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is malformed. Paste only the raw token value, for example vercel_blob_rw_..., without "BLOB_READ_WRITE_TOKEN=", quotes, or extra text.'
    );
  }
}

function checkHardTimeoutMs() {
  const configured = Number(process.env.CHECK_HARD_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured);

  const maxRuntimeMs = Number(process.env.CHECK_MAX_RUNTIME_MS);
  if (Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0) return Math.round(maxRuntimeMs + 5 * 60 * 1000);

  return 0;
}

async function recordForcedExit(error, exitCode, context) {
  if (context.forcedExitState.recording) return;
  context.forcedExitState.recording = true;

  const finishedAt = new Date().toISOString();
  console.error(JSON.stringify({
    error,
    hardTimeoutMs: context.hardTimeoutMs,
    finishedAt
  }));

  try {
    await recordCronRun({
      lastCronStartedAt: context.scriptStartedAt,
      lastCronFinishedAt: finishedAt,
      lastCronExecutionBoundaryAt: context.scheduleIntent.executionBoundaryAt,
      lastCronSchedule: context.scheduleIntent.scheduleCron,
      lastCronBackup: true,
      lastCronStoppedByRuntimeLimit: true,
      lastCronError: error
    });
  } catch (recordError) {
    console.error(JSON.stringify({
      error: 'Failed to record forced cron exit',
      cause: recordError.message || String(recordError)
    }));
  }

  process.exit(exitCode);
}

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
