import { spawnSync } from 'node:child_process';

const KEYCHAIN_SERVICE = 'kindle-price-watch-github-actions';
const KEYCHAIN_ACCOUNT = 'hiyokko';

const token = readClipboard().trim();
if (!token) {
  throw new Error('Clipboard is empty. Copy a GitHub fine-grained PAT before running this script.');
}

if (!/^(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)/.test(token)) {
  throw new Error('Clipboard does not look like a GitHub token. Refusing to save it.');
}

const result = spawnSync('security', [
  'add-generic-password',
  '-U',
  '-a',
  KEYCHAIN_ACCOUNT,
  '-s',
  KEYCHAIN_SERVICE,
  '-w',
  token
], {
  encoding: 'utf8'
});

clearClipboard();

if (result.status !== 0) {
  throw new Error((result.stderr || result.stdout || '').trim() || `security failed with exit code ${result.status}`);
}

console.log(JSON.stringify({
  ok: true,
  keychainService: KEYCHAIN_SERVICE,
  keychainAccount: KEYCHAIN_ACCOUNT,
  clipboardCleared: true
}, null, 2));

function readClipboard() {
  const result = spawnSync('pbpaste', [], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) return '';
  return result.stdout || '';
}

function clearClipboard() {
  spawnSync('pbcopy', [], {
    input: '',
    encoding: 'utf8'
  });
}
