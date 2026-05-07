import { getHistory } from '../../../src/checker.mjs';
import { handleError, requireMethod, sendJson } from '../../../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['GET'])) return;
    sendJson(res, 200, { history: await getHistory(req.query.id) });
  } catch (error) {
    handleError(res, error);
  }
}
