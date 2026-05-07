import { historyPayload } from '../../../src/app-api.mjs';
import { handleError, requireMethod, sendJson } from '../../../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['GET'])) return;
    sendJson(res, 200, await historyPayload(req.query.id));
  } catch (error) {
    handleError(res, error);
  }
}
