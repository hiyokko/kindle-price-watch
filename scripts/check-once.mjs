import { loadEnv } from '../src/env.mjs';
import { recordCronRun, resolveCronScheduleIntent, runDueChecks } from '../src/checker.mjs';
import { compactCronRunResult } from '../src/cron-run-log.mjs';

loadEnv();
validateActionEnvironment();

const scriptStartedAt = new Date().toISOString();
const hardTimeoutMs = checkHardTimeoutMs();
const scheduleCron = process.env.CHECK_SCHEDULE_CRON || '';
const isBackupRun = readBooleanEnv('CHECK_BACKUP_RUN', false);
let forcedExitRecording = false;
const watchdog = hardTimeoutMs > 0
  ? setTimeout(() => {
      void recordForcedExit('CHECK_HARD_TIMEOUT_MS elapsed', 124, { hardTimeoutMs });
    }, hardTimeoutMs)
  : null;

process.once('SIGTERM', () => {
  void recordForcedExit('SIGTERM received', 143);
});

try {
  const result = await runDueChecks({
    notify: true,
    source: 'cron',
    backup: isBackupRun,
    scheduleCron
  });
  console.log(JSON.stringify(compactCronRunResult(result), null, 2));
} finally {
  if (watchdog) clearTimeout(watchdog);
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

function readBooleanEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

async function recordForcedExit(error, exitCode, details = {}) {
  if (forcedExitRecording) return;
  forcedExitRecording = true;

  const finishedAt = new Date().toISOString();
  const scheduleIntent = resolveCronScheduleIntent(scheduleCron, Date.now());
  console.error(JSON.stringify({
    error,
    ...details,
    finishedAt
  }));

  try {
    await recordCronRun({
      lastCronStartedAt: scriptStartedAt,
      lastCronFinishedAt: finishedAt,
      ...(scheduleIntent
        ? {
            lastCronExecutionBoundaryAt: scheduleIntent.executionBoundaryAt,
            lastCronSchedule: scheduleIntent.scheduleCron
          }
        : {}),
      lastCronBackup: isBackupRun,
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
