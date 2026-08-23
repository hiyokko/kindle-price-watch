import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, readNumberEnv } from './src/env.mjs';
import { buildBodyResponse } from './src/http-response.mjs';
import { registerStorePayloadSync } from './src/store-payload-sync.mjs';
import {
  addBooksPayload,
  bootstrapPayloadResponse,
  checkBookPayload,
  deleteBookPayload,
  deleteBooksPayload,
  deleteSeriesPayload,
  historyPayload,
  importQueuePayload,
  listBooksPayloadResponse,
  runChecksPayload,
  saveSettingsPayload,
  saveImportQueuePayload,
  saveWebhooksPayload,
  settingsPayloadResponse,
  testNotificationPayload,
  webhooksPayload
} from './src/app-api.mjs';

loadEnv();
registerStorePayloadSync();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const port = readNumberEnv('PORT', 4173);
const sessionCookieName = 'kw_session';
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/login') {
      await handleLogin(req, res);
      return;
    }

    if (url.pathname === '/logout') {
      clearSessionCookie(req, res);
      redirect(res, '/login');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { error: 'ログインが必要です' });
        return;
      }

      await handleApi(req, res, url);
      return;
    }

    if (!isAuthenticated(req)) {
      redirect(res, '/login');
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.status ? error.message : 'サーバーエラーが発生しました'
    });
    if (!error.status) console.error(error);
  }
});

server.listen(port, () => {
  console.log(`Kindle Price Watch: http://localhost:${port}`);
});

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathParts = url.pathname.split('/').filter(Boolean);

  if (method === 'GET' && url.pathname === '/api/bootstrap') {
    sendResponse(res, await bootstrapPayloadResponse(req));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/books') {
    sendResponse(res, await listBooksPayloadResponse(req));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/books') {
    sendJson(res, 201, await addBooksPayload(await readBody(req)));
    return;
  }

  if (method === 'DELETE' && url.pathname === '/api/books') {
    sendJson(res, 200, await deleteBooksPayload(await readBody(req)));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/check') {
    sendJson(res, 200, await runChecksPayload({ source: 'manual' }));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/import-queue') {
    sendJson(res, 200, await importQueuePayload());
    return;
  }

  if ((method === 'PUT' || method === 'POST') && url.pathname === '/api/import-queue') {
    sendJson(res, 200, await saveImportQueuePayload(await readBody(req)));
    return;
  }

  if (method === 'DELETE' && url.pathname === '/api/series') {
    sendJson(res, 200, await deleteSeriesPayload(await readBody(req)));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/settings') {
    sendResponse(res, await settingsPayloadResponse(req));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/webhooks') {
    sendJson(res, 200, await webhooksPayload());
    return;
  }

  if (method === 'PUT' && url.pathname === '/api/webhooks') {
    sendJson(res, 200, await saveWebhooksPayload(await readBody(req)));
    return;
  }

  if (method === 'PUT' && url.pathname === '/api/settings') {
    sendJson(res, 200, await saveSettingsPayload(await readBody(req)));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/notify/test') {
    sendJson(res, 200, await testNotificationPayload());
    return;
  }

  if (pathParts[0] === 'api' && pathParts[1] === 'books' && pathParts[2]) {
    const bookId = pathParts[2];

    if (method === 'DELETE' && pathParts.length === 3) {
      sendJson(res, 200, await deleteBookPayload(bookId));
      return;
    }

    if (method === 'POST' && pathParts[3] === 'check') {
      sendJson(res, 200, await checkBookPayload(bookId));
      return;
    }

    if (method === 'GET' && pathParts[3] === 'history') {
      sendJson(res, 200, await historyPayload(bookId));
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function handleLogin(req, res) {
  const method = req.method || 'GET';

  if (!isAuthEnabled() || isAuthenticated(req)) {
    redirect(res, '/');
    return;
  }

  if (method === 'GET') {
    sendLoginPage(res);
    return;
  }

  if (method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    sendLoginPage(res, 'Method not allowed', 405);
    return;
  }

  const body = await readBody(req);
  if (!passwordMatches(body.password)) {
    sendLoginPage(res, 'パスワードが違います', 401);
    return;
  }

  setSessionCookie(req, res);
  redirect(res, '/');
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxRequestBodyBytes()) {
      const error = new Error('リクエストが大きすぎます');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};

  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('JSONを解析できませんでした');
    error.status = 400;
    throw error;
  }
}

function maxRequestBodyBytes() {
  return readNumberEnv('MAX_REQUEST_BODY_BYTES', 1024 * 1024);
}

function isAuthEnabled() {
  return Boolean(process.env.APP_PASSWORD);
}

function isAuthenticated(req) {
  if (!isAuthEnabled()) return true;
  return verifySessionValue(parseCookies(req)[sessionCookieName]);
}

function passwordMatches(value) {
  const expected = process.env.APP_PASSWORD || '';
  const actualBuffer = Buffer.from(String(value || ''));
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function createSessionValue() {
  const issuedAt = Date.now().toString(36);
  return `${issuedAt}.${signSession(issuedAt)}`;
}

function verifySessionValue(value) {
  const [issuedAt, signature] = String(value || '').split('.');
  if (!issuedAt || !signature) return false;

  const issuedAtMs = Number.parseInt(issuedAt, 36);
  if (!Number.isFinite(issuedAtMs)) return false;
  if (Date.now() - issuedAtMs > sessionMaxAgeSeconds * 1000) return false;

  return safeEqual(signature, signSession(issuedAt));
}

function signSession(value) {
  const secret = process.env.APP_SESSION_SECRET || process.env.APP_PASSWORD || 'development';
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseCookies(req) {
  const cookies = {};
  const raw = req.headers.cookie || '';

  for (const part of raw.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (!name) continue;
    cookies[name] = decodeURIComponent(valueParts.join('=') || '');
  }

  return cookies;
}

function setSessionCookie(req, res) {
  res.setHeader('Set-Cookie', cookieHeader(sessionCookieName, createSessionValue(), req, {
    httpOnly: true,
    maxAge: sessionMaxAgeSeconds
  }));
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', cookieHeader(sessionCookieName, '', req, {
    httpOnly: true,
    maxAge: 0
  }));
}

function cookieHeader(name, value, req, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax'
  ];

  if (options.httpOnly) parts.push('HttpOnly');
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (isSecureRequest(req)) parts.push('Secure');

  return parts.join('; ');
}

function isSecureRequest(req) {
  return process.env.VERCEL === '1' || req.headers['x-forwarded-proto'] === 'https';
}

function redirect(res, location) {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store'
  });
  res.end();
}

function sendLoginPage(res, error = '', status = 200) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  });
  res.end(`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Kindle Price Watch Login</title>
    <style>
      :root {
        --bg: #fbfaf7;
        --surface: #ffffff;
        --text: #22272a;
        --muted: #657174;
        --line: #dfe6e3;
        --accent: #e85d4f;
        --accent-strong: #d64b3e;
        --radius: 8px;
        color-scheme: light;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, "Noto Sans JP", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      }
      main {
        width: min(100%, 360px);
        display: grid;
        gap: 18px;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-weight: 800;
      }
      .mark {
        display: inline-grid;
        place-items: center;
        width: 36px;
        height: 36px;
        border-radius: var(--radius);
        background: var(--text);
        color: var(--surface);
      }
      form {
        display: grid;
        gap: 14px;
        padding: 22px;
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: var(--radius);
      }
      label {
        display: grid;
        gap: 8px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 700;
      }
      input {
        width: 100%;
        height: 44px;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 0 12px;
        color: var(--text);
        font: inherit;
      }
      input:focus {
        outline: 2px solid rgba(232, 93, 79, 0.2);
        border-color: var(--accent);
      }
      button {
        min-height: 44px;
        border: 0;
        border-radius: var(--radius);
        background: var(--accent);
        color: #fff;
        font: inherit;
        font-weight: 800;
        cursor: pointer;
      }
      button:hover { background: var(--accent-strong); }
      .error {
        margin: 0;
        color: #b84242;
        font-size: 13px;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="brand"><span class="mark">K</span><span>Kindle Price Watch</span></div>
      <form method="post" action="/login">
        <label>
          <span>パスワード</span>
          <input name="password" type="password" autocomplete="current-password" autofocus required>
        </label>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
        <button type="submit">ログイン</button>
      </form>
    </main>
  </body>
</html>`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function serveStatic(req, res, pathname) {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, cleanPath));
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    sendBody(res, 200, body, {
      req,
      contentType: contentType(filePath),
      etag: true,
      cacheControl: 'private, no-cache, max-age=0'
    });
  } catch {
    const fallback = await fs.readFile(path.join(publicDir, 'index.html'));
    sendBody(res, 200, fallback, {
      req,
      contentType: 'text/html; charset=utf-8',
      etag: true,
      cacheControl: 'private, no-cache, max-age=0'
    });
  }
}

function sendJson(res, status, payload, options = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  sendBody(res, status, body, {
    ...options,
    contentType: 'application/json; charset=utf-8'
  });
}

function sendBody(res, status, body, options = {}) {
  const response = buildBodyResponse(status, body, options);
  sendResponse(res, response);
}

function sendResponse(res, response) {
  res.writeHead(response.status, {
    ...response.headers,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  });
  res.end(response.body);
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml'
  };
  return types[ext] || 'application/octet-stream';
}
