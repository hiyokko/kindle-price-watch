import { loadEnv, loadEnvFile } from '../src/env.mjs';
import '../src/checker.mjs';
import { hasBlobConfig, readStoreWithMetadata, updateStore } from '../src/store.mjs';

loadEnvFile('.env.production.local');
loadEnv();

if (!hasBlobConfig()) {
  throw new Error('BLOB_READ_WRITE_TOKEN is required to optimize production Blob storage.');
}

const before = await readStoreWithMetadata({ force: true });
const next = await updateStore((store) => store);
const after = await readStoreWithMetadata();

console.log(JSON.stringify({
  optimized: true,
  bookCount: next.books.length,
  beforeBytes: before.size || 0,
  compressedBytes: after.size || 0,
  reductionPercent: percentReduction(before.size, after.size)
}, null, 2));

function percentReduction(before, after) {
  const source = Number(before);
  const target = Number(after);
  if (!Number.isFinite(source) || source <= 0 || !Number.isFinite(target)) return null;
  return Math.round((1 - target / source) * 1000) / 10;
}
