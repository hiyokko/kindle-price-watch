import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    normalizeRuntimeEnv();
    return;
  }

  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = normalizeEnvValue(value, key);
    }
  }

  normalizeRuntimeEnv();
}

function normalizeRuntimeEnv() {
  const names = [
    'BLOB_READ_WRITE_TOKEN',
    'DISCORD_WEBHOOK_URL',
    'DISCORD_WEBHOOK_URLS',
    'APP_PASSWORD',
    'APP_SESSION_SECRET',
    'KEEPA_API_KEY'
  ];

  for (const name of names) {
    if (process.env[name] != null) {
      process.env[name] = normalizeEnvValue(process.env[name], name);
    }
  }
}

function normalizeEnvValue(value, key = '') {
  let normalized = String(value || '').trim();
  if (key && normalized.startsWith(`${key}=`)) {
    normalized = normalized.slice(key.length + 1).trim();
  }
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

export function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
