import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-price-watch-deploy-'));

await copyProject(projectRoot, uploadDir);
await assertVercelProjectLinked(uploadDir);
await deploy(uploadDir);

console.log(`Deployed from Git-free upload directory: ${uploadDir}`);

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

function shouldExclude(relativePath, entry) {
  const parts = relativePath.split(path.sep);
  const name = parts.at(-1) || '';

  if (parts.includes('.git') || parts.includes('node_modules')) return true;
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
    await fs.access(projectJsonPath);
  } catch {
    if (process.env.VERCEL_PROJECT_ID && process.env.VERCEL_ORG_ID) return;
    throw new Error(
      'Vercel project link is missing. Run `vercel link` once locally, or set VERCEL_PROJECT_ID and VERCEL_ORG_ID.'
    );
  }
}

async function deploy(cwd) {
  const candidates = await vercelDeployCommands();
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

async function vercelDeployCommands() {
  const commands = [];

  if (process.env.VERCEL_CLI) {
    commands.push({
      label: process.env.VERCEL_CLI,
      command: process.env.VERCEL_CLI,
      args: ['deploy', '--prod']
    });
  }

  const bundledNpm = '/private/tmp/npm-cli/package/bin/npm-cli.js';
  if (await exists(bundledNpm)) {
    commands.push({
      label: bundledNpm,
      command: process.execPath,
      args: [bundledNpm, 'exec', '--yes', 'vercel@latest', '--', 'deploy', '--prod']
    });
  }

  commands.push(
    {
      label: 'vercel',
      command: 'vercel',
      args: ['deploy', '--prod']
    },
    {
      label: 'npm exec vercel@latest',
      command: 'npm',
      args: ['exec', '--yes', 'vercel@latest', '--', 'deploy', '--prod']
    },
    {
      label: 'npx vercel@latest',
      command: 'npx',
      args: ['--yes', 'vercel@latest', 'deploy', '--prod']
    }
  );

  return commands;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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
