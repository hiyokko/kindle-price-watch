import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../src/env.mjs';
import { cronWindowCompletionState, resolveCronScheduleIntent } from '../src/checker.mjs';
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

  const dispatch = await dispatchPriceCheckWorkflow(target);
  console.log(JSON.stringify({
    watchdog: true,
    dispatched: true,
    target,
    dispatch
  }, null, 2));
}

export function workflowDispatchInputs(target) {
  return {
    force_all: 'false',
    schedule_cron: target.cron,
    backup: 'true'
  };
}

async function dispatchPriceCheckWorkflow(target) {
  const repository = process.env.GITHUB_REPOSITORY || 'hiyokko/kindle-price-watch';
  const ref = process.env.GITHUB_REF_NAME || process.env.GITHUB_REF?.replace(/^refs\/heads\//, '') || 'main';
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set. The watchdog needs Actions write permission to dispatch kindle-price-check.yml.');
  }

  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/kindle-price-check.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        ref,
        inputs: workflowDispatchInputs(target)
      })
    }
  );

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.message ? `: ${body.message}` : '';
    } catch {
      detail = '';
    }
    throw new Error(`Failed to dispatch kindle-price-check.yml (${response.status})${detail}`);
  }

  return {
    repository,
    ref,
    workflow: 'kindle-price-check.yml',
    inputs: workflowDispatchInputs(target)
  };
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

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
