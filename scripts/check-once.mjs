import { loadEnv } from '../src/env.mjs';
import { runDueChecks } from '../src/checker.mjs';

loadEnv();

const result = await runDueChecks({ notify: true, source: 'cron' });
console.log(JSON.stringify(result, null, 2));
