import { loadEnv } from '../src/env.mjs';
import { runDueChecks } from '../src/checker.mjs';

loadEnv();
validateActionEnvironment();

const result = await runDueChecks({ notify: true, source: 'cron' });
console.log(JSON.stringify(result, null, 2));

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
