export const MINIMUM_NODE_VERSION = '24.22.1';

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
    advisory: 'CVE-2026-111497'
  };
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
