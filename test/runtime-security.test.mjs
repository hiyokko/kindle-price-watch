import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
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

test('managed runtime mitigation blocks native Brotli APIs and fetched br bodies while gzip still works', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import zlib, { brotliDecompressSync } from 'node:zlib';
    import { pipeline } from 'node:stream/promises';
    import { Readable, Writable } from 'node:stream';
    import { MockAgent, setGlobalDispatcher, fetch as sdkFetch } from 'undici';
    import { protectManagedRuntime } from './src/runtime-security.mjs';
    Object.defineProperty(process.versions, 'node', { value: '24.21.0' });
    const brotli = zlib.brotliCompressSync(Buffer.from('test response'));
    const gzip = zlib.gzipSync(Buffer.from('test response'));
    const status = protectManagedRuntime();
    assert.equal(status.securityUpdateApplied, false);
    assert.equal(status.protected, true);
    assert.equal(status.brotliDecoderDisabled, true);
    assert.deepEqual(protectManagedRuntime(), status);
    for (const method of [zlib.brotliDecompress, zlib.brotliDecompressSync, brotliDecompressSync]) {
      assert.throws(() => method(brotli), { code: 'ERR_BROTLI_DISABLED_SECURITY' });
    }
    for (const stream of [zlib.createBrotliDecompress(), new zlib.BrotliDecompress()]) {
      await assert.rejects(pipeline(Readable.from([brotli]), stream, new Writable({ write(_chunk, _encoding, callback) { callback(); } })),
        { code: 'ERR_BROTLI_DISABLED_SECURITY' });
    }
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const pool = agent.get('https://runtime.test');
    pool.intercept({ path: '/gzip', headers: { 'accept-encoding': 'gzip, deflate' } })
      .reply(200, gzip, { headers: { 'content-encoding': 'gzip' } });
    assert.equal(await (await fetch('https://runtime.test/gzip')).text(), 'test response');
    for (const [path, fetcher] of [['/native-br', fetch], ['/sdk-br', sdkFetch]]) {
      pool.intercept({ path }).reply(200, brotli, { headers: { 'content-encoding': 'br' } });
      await assert.rejects(async () => (await fetcher('https://runtime.test' + path)).text(),
        (error) => error.code === 'ERR_BROTLI_DISABLED_SECURITY' || error.cause?.code === 'ERR_BROTLI_DISABLED_SECURITY');
    }
    await agent.close();
    console.log('mitigation verified');
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.match(output, /mitigation verified/);
});
