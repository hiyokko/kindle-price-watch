import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSecureRuntime } from '../src/runtime-security.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERCEL_CLI_VERSION = '65.2.0';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

async function main() {
  assertSecureRuntime();
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-price-watch-deploy-'));
  try {
    await copyProject(projectRoot, uploadDir);
    const project = await assertVercelProjectLinked(uploadDir);
    await deploy(uploadDir, process.env.VERCEL_SCOPE || project.orgId);
    console.log('Deployed from a Git-free upload directory.');
  } finally {
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
}

async function copyProject(sourceRoot, targetRoot) {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    await copyEntry(sourcePath, targetPath, entry.name, entry);
  }
}

async function copyEntry(sourcePath, targetPath, relativePath, entry) {
  if (shouldExclude(relativePath, entry)) return;

  if (entry.isDirectory()) {
    await fs.mkdir(targetPath, { recursive: true });
    const children = await fs.readdir(sourcePath, { withFileTypes: true });
    for (const child of children) {
      await copyEntry(
        path.join(sourcePath, child.name),
        path.join(targetPath, child.name),
        path.join(relativePath, child.name),
        child
      );
    }
    return;
  }

  if (entry.isSymbolicLink()) {
    const link = await fs.readlink(sourcePath);
    await fs.symlink(link, targetPath);
    return;
  }

  if (entry.isFile()) await fs.copyFile(sourcePath, targetPath);
}

export function shouldExclude(relativePath, entry) {
  const parts = relativePath.split(path.sep);
  const name = parts.at(-1) || '';

  if (parts.includes('.git') || parts.includes('node_modules')) return true;
  if (['.aws', '.codex', '.agents'].includes(parts[0])) return true;
  if (name === '.DS_Store' || /^npm-debug\.log/.test(name)) return true;
  if (isLocalEnvFile(name)) return true;
  if (parts[0] === 'data' && /\.(?:json|tmp)$/i.test(name)) return true;

  if (parts[0] === '.vercel') {
    return !(relativePath === '.vercel' || relativePath === path.join('.vercel', 'project.json'));
  }

  return false;
}

function isLocalEnvFile(name) {
  if (name === '.env.example') return false;
  return name === '.env' || /^\.env\./.test(name);
}

async function assertVercelProjectLinked(root) {
  const projectJsonPath = path.join(root, '.vercel', 'project.json');
  try {
    return JSON.parse(await fs.readFile(projectJsonPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (process.env.VERCEL_PROJECT_ID && process.env.VERCEL_ORG_ID) {
      return { projectId: process.env.VERCEL_PROJECT_ID, orgId: process.env.VERCEL_ORG_ID };
    }
    throw new Error(
      'Vercel project link is missing. Run `vercel link` once locally, or set VERCEL_PROJECT_ID and VERCEL_ORG_ID.'
    );
  }
}

async function deploy(cwd, scope) {
  const candidates = vercelDeployCommands(scope);
  const missing = [];

  for (const candidate of candidates) {
    try {
      await run(candidate.command, candidate.args, cwd);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') {
        missing.push(candidate.label);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`No Vercel CLI runner found. Tried: ${missing.join(', ')}`);
}

export function vercelDeployCommands(scope) {
  const commands = [];
  const args = ['deploy', '--prod', ...(scope ? ['--scope', scope] : [])];

  if (process.env.VERCEL_CLI) {
    commands.push({
      label: process.env.VERCEL_CLI,
      command: /\.[cm]?js$/i.test(process.env.VERCEL_CLI) ? process.execPath : process.env.VERCEL_CLI,
      args: /\.[cm]?js$/i.test(process.env.VERCEL_CLI) ? [process.env.VERCEL_CLI, ...args] : args
    });
  }

  commands.push({
    label: 'vercel',
    command: 'vercel',
    args
  });

  commands.push(
    {
      label: `npm exec vercel@${VERCEL_CLI_VERSION}`,
      command: 'npm',
      args: ['exec', '--yes', `vercel@${VERCEL_CLI_VERSION}`, '--', ...args]
    },
    {
      label: `npx vercel@${VERCEL_CLI_VERSION}`,
      command: 'npx',
      args: ['--yes', `vercel@${VERCEL_CLI_VERSION}`, ...args]
    }
  );

  return commands;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: process.env
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed with ${signal || `exit code ${code}`}`));
    });
  });
}
