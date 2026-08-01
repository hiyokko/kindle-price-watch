import { auditSingleBookSeriesClassifications } from '../src/checker.mjs';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const force = args.has('--all');
const limitArg = process.argv.slice(2).find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : force ? 1000 : undefined;

const result = await auditSingleBookSeriesClassifications({
  apply,
  force,
  limit,
  itemMaxRuntimeMs: force ? 180000 : undefined
});

console.log(JSON.stringify(result, null, 2));

if (!apply) {
  console.error('Dry run only. Persist the reviewed result with --apply.');
}
