import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldExclude, vercelDeployCommands } from '../scripts/deploy-production.mjs';

test('production uploads exclude credentials, Git metadata and local database copies', () => {
  for (const path of ['.env', '.env.production.local', '.git/config', 'node_modules/pkg/index.js',
    'data/store.json', 'data/repair.tmp', '.vercel/auth.json', '.aws/credentials', '.codex/settings.json']) {
    assert.equal(shouldExclude(path), true, path);
  }
  for (const path of ['.env.example', '.vercel', '.vercel/project.json', 'server.mjs', 'src/check-planner.mjs', 'public/app.js']) {
    assert.equal(shouldExclude(path), false, path);
  }
});

test('deployment commands carry the linked team scope and avoid moving latest versions', () => {
  const commands = vercelDeployCommands('team-example');
  for (const command of commands) {
    const scopeIndex = command.args.indexOf('--scope');
    assert.equal(command.args[scopeIndex + 1], 'team-example');
    assert.equal(command.args.some((arg) => arg.includes('@latest')), false);
  }
});
