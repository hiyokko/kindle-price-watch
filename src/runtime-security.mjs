import zlib from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import { Transform } from 'node:stream';

export const MINIMUM_NODE_VERSION = '24.22.1';
let brotliDecoderDisabled = false;

export function runtimeSecurityStatus(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  const secure = Boolean(match && Number(match[1]) === 24 && (
    Number(match[2]) > 22 || (Number(match[2]) === 22 && Number(match[3]) >= 1)
  ));
  return {
    nodeVersion: version,
    minimumNodeVersion: MINIMUM_NODE_VERSION,
    supportedMajor: 24,
    securityUpdateApplied: secure,
    brotliDecoderDisabled,
    protected: secure || brotliDecoderDisabled,
    advisory: 'CVE-2026-111497'
  };
}

export function protectManagedRuntime() {
  if (runtimeSecurityStatus().securityUpdateApplied || brotliDecoderDisabled) return runtimeSecurityStatus();
  if (!process.versions.node.startsWith('24.')) return assertSecureRuntime();

  // Block native decoding itself: Accept-Encoding alone cannot stop an unsolicited br response.
  function brotliDisabledError() {
    const error = new Error('Brotli decoding is disabled pending the managed Node.js security update (CVE-2026-111497).');
    error.code = 'ERR_BROTLI_DISABLED_SECURITY';
    return error;
  }
  function disabledBrotliDecoder() {
    throw brotliDisabledError();
  }
  function blockedBrotliStream() {
    // Fail through the stream pipeline so older fetch implementations can clean up safely.
    return new Transform({
      transform(_chunk, _encoding, callback) { callback(brotliDisabledError()); },
      flush(callback) { callback(brotliDisabledError()); }
    });
  }
  for (const name of ['brotliDecompress', 'brotliDecompressSync']) {
    Object.defineProperty(zlib, name, { value: disabledBrotliDecoder });
  }
  for (const name of ['createBrotliDecompress', 'BrotliDecompress']) {
    Object.defineProperty(zlib, name, { value: blockedBrotliStream });
  }
  syncBuiltinESMExports();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options = {}) => {
    const headers = new Headers(options.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('Accept-Encoding', 'gzip, deflate');
    return originalFetch(input, { ...options, headers });
  };
  brotliDecoderDisabled = true;
  return runtimeSecurityStatus();
}

export function assertSecureRuntime(version = process.versions.node) {
  const status = runtimeSecurityStatus(version);
  if (!status.securityUpdateApplied) {
    const error = new Error(`Node.js ${version} is not supported. Use Node.js 24.x >= ${MINIMUM_NODE_VERSION} to address ${status.advisory}.`);
    error.status = 503;
    throw error;
  }
  return status;
}
