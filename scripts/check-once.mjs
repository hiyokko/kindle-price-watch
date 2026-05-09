import { loadEnv } from '../src/env.mjs';
import { runDueChecks } from '../src/checker.mjs';

loadEnv();
validateActionEnvironment();

const hardTimeoutMs = checkHardTimeoutMs();
const watchdog = hardTimeoutMs > 0
  ? setTimeout(() => {
      console.error(JSON.stringify({
        error: 'CHECK_HARD_TIMEOUT_MS elapsed',
        hardTimeoutMs,
        finishedAt: new Date().toISOString()
      }));
      process.exit(124);
    }, hardTimeoutMs)
  : null;

try {
  const result = await runDueChecks({ notify: true, source: 'cron' });
  console.log(JSON.stringify(result, null, 2));
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
