import { assertSecureRuntime } from '../src/runtime-security.mjs';

console.log(JSON.stringify(assertSecureRuntime(), null, 2));
