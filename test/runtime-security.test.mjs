import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSecureRuntime, runtimeSecurityStatus } from '../src/runtime-security.mjs';

test('runtime checks reject vulnerable, unsupported, and prerelease Node builds', () => {
  for (const version of ['20.20.0', '22.23.4', '24.19.0', '24.21.0', '24.22.0', '24.22.1-rc.1', '25.0.0', 'invalid']) {
    assert.equal(runtimeSecurityStatus(version).securityUpdateApplied, false, version);
    assert.throws(() => assertSecureRuntime(version), { status: 503 });
  }
});

test('runtime checks accept the patched release and later Node 24 patches', () => {
  for (const version of ['24.22.1', '24.22.2', '24.23.0']) {
    assert.equal(assertSecureRuntime(version).securityUpdateApplied, true, version);
  }
});
