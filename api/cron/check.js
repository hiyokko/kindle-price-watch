import { runChecksPayload } from '../../src/app-api.mjs';
import { handleError, requireCronAuth, requireMethod, sendJson } from '../../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['GET', 'POST'])) return;
    if (!requireCronAuth(req, res)) return;
    sendJson(res, 200, await runChecksPayload({ source: 'cron' }));
  } catch (error) {
    handleError(res, error);
  }
}
