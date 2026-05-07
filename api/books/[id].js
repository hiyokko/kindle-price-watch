import { deleteBookPayload } from '../../src/app-api.mjs';
import { handleError, requireMethod, sendJson } from '../../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['DELETE'])) return;
    sendJson(res, 200, await deleteBookPayload(req.query.id));
  } catch (error) {
    handleError(res, error);
  }
}
