import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNER = 'hiyokko';
const REPO = 'kindle-price-watch';
const WORKFLOW = 'kindle-price-check.yml';
const KEYCHAIN_SERVICE = 'kindle-price-watch-github-actions';
const KEYCHAIN_ACCOUNT = 'hiyokko';
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPO}`;

const command = process.argv[2] || 'runs';
const args = process.argv.slice(3);

try {
  if (command === 'runs') {
    await listRuns();
  } else if (command === 'jobs') {
    await listJobs(requiredArg('run id'));
  } else if (command === 'logs') {
    await printLogs(requiredArg('run id'));
  } else if (command === 'doctor') {
    await doctor();
  } else {
    usage(1);
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}

async function listRuns() {
  const limit = numberOption('--limit', 10);
  const data = await githubJson(`/actions/workflows/${encodeURIComponent(WORKFLOW)}/runs?per_page=${limit}`);
  const runs = data.workflow_runs || [];

  if (hasFlag('--json')) {
    console.log(JSON.stringify(runs.map(publicRun), null, 2));
    return;
  }

  for (const run of runs) {
    const item = publicRun(run);
    console.log([
      item.id,
      item.event,
      item.status,
      item.conclusion || '-',
      `created=${item.createdAtJst}`,
      `started=${item.startedAtJst}`,
      `updated=${item.updatedAtJst}`,
      item.url
    ].join(' | '));
  }
}

async function listJobs(runId) {
  const data = await githubJson(`/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=100`);
  const jobs = data.jobs || [];

  if (hasFlag('--json')) {
    console.log(JSON.stringify(jobs.map(publicJob), null, 2));
    return;
  }

  for (const job of jobs) {
    const item = publicJob(job);
    console.log(`${item.id} | ${item.name} | ${item.status} | ${item.conclusion || '-'} | ${item.startedAtJst} -> ${item.completedAtJst} | ${item.duration}`);
    for (const step of item.steps) {
      console.log(`  - ${step.number}. ${step.name} | ${step.status} | ${step.conclusion || '-'} | ${step.startedAtJst} -> ${step.completedAtJst}`);
    }
  }
}

async function printLogs(runId) {
  const response = await githubFetch(`/actions/runs/${encodeURIComponent(runId)}/logs`, {
    headers: {
      Accept: 'application/vnd.github+json'
    }
  });
  if (!response.ok) await throwApiError(response);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'kpw-actions-logs-'));
  const zipPath = path.join(tempDir, `${runId}.zip`);
  try {
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
    const unzip = spawnSync('unzip', ['-p', zipPath], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    });
    if (unzip.status !== 0) {
      throw new Error((unzip.stderr || '').trim() || `unzip failed with exit code ${unzip.status}`);
    }

    let output = unzip.stdout || '';
    const grep = stringOption('--grep');
    if (grep) {
      const pattern = new RegExp(grep, 'i');
      output = output.split(/\r?\n/).filter((line) => pattern.test(line)).join('\n');
    }

    const tail = numberOption('--tail', 0);
    if (tail > 0) {
      output = output.split(/\r?\n/).slice(-tail).join('\n');
    }

    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function doctor() {
  const token = readToken();
  const data = await githubJson('');
  console.log(JSON.stringify({
    ok: true,
    repository: data.full_name,
    private: data.private,
    tokenSource: token.source,
    keychainService: KEYCHAIN_SERVICE,
    keychainAccount: KEYCHAIN_ACCOUNT
  }, null, 2));
}

async function githubJson(route) {
  const response = await githubFetch(route);
  if (!response.ok) await throwApiError(response);
  return response.json();
}

async function githubFetch(route, options = {}) {
  const token = readToken().value;
  return fetch(`${API_ROOT}${route}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
}

async function throwApiError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body.message ? `: ${body.message}` : '';
  } catch {
    detail = '';
  }
  throw new Error(`GitHub API request failed (${response.status})${detail}`);
}

function readToken() {
  const envToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (envToken) return { value: envToken, source: 'environment' };

  if (process.platform === 'darwin') {
    const result = spawnSync('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w'
    ], {
      encoding: 'utf8'
    });

    const token = (result.stdout || '').trim();
    if (result.status === 0 && token) return { value: token, source: 'macOS Keychain' };
  }

  throw new Error(
    `GitHub token is not available. Save it with \`node scripts/save-github-actions-token.mjs\`, or set GITHUB_TOKEN for one command.`
  );
}

function publicRun(run) {
  return {
    id: run.id,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    createdAtJst: formatJst(run.created_at),
    startedAt: run.run_started_at,
    startedAtJst: formatJst(run.run_started_at),
    updatedAt: run.updated_at,
    updatedAtJst: formatJst(run.updated_at),
    title: run.display_title,
    url: run.html_url
  };
}

function publicJob(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    startedAtJst: formatJst(job.started_at),
    completedAt: job.completed_at,
    completedAtJst: formatJst(job.completed_at),
    duration: duration(job.started_at, job.completed_at),
    url: job.html_url,
    steps: (job.steps || []).map((step) => ({
      number: step.number,
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      startedAt: step.started_at,
      startedAtJst: formatJst(step.started_at),
      completedAt: step.completed_at,
      completedAtJst: formatJst(step.completed_at)
    }))
  };
}

function requiredArg(label) {
  const value = args.find((arg) => !arg.startsWith('--'));
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function hasFlag(name) {
  return args.includes(name);
}

function stringOption(name) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  return args[index + 1] || '';
}

function numberOption(name, fallback) {
  const raw = stringOption(name);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function formatJst(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function duration(startedAt, completedAt) {
  const start = new Date(startedAt || 0).getTime();
  const end = new Date(completedAt || 0).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) return '-';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${rest}s`;
  if (minutes > 0) return `${minutes}m${rest}s`;
  return `${rest}s`;
}

function usage(exitCode = 0) {
  console.log(`Usage:
  node scripts/github-actions.mjs doctor
  node scripts/github-actions.mjs runs [--limit 10] [--json]
  node scripts/github-actions.mjs jobs <run-id> [--json]
  node scripts/github-actions.mjs logs <run-id> [--grep PATTERN] [--tail N]`);
  process.exit(exitCode);
}
