import { loadEnv } from './env.mjs';

loadEnv();

export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function handleError(res, error) {
  sendJson(res, error.status || 500, {
    error: error.status ? error.message : 'サーバーエラーが発生しました'
  });
  if (!error.status) console.error(error);
}

export function requireMethod(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  res.setHeader('Allow', allowed.join(', '));
  sendJson(res, 405, { error: 'Method not allowed' });
  return false;
}

export function requireCronAuth(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const authorization = req.headers.authorization || '';
  if (authorization === `Bearer ${secret}`) return true;

  sendJson(res, 401, { error: 'Unauthorized' });
  return false;
}
