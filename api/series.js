import { deleteSeriesPayload } from '../src/app-api.mjs';
import { handleError, readJsonBody, requireMethod, sendJson } from '../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['DELETE'])) return;
    sendJson(res, 200, await deleteSeriesPayload(await readJsonBody(req)));
  } catch (error) {
    handleError(res, error);
  }
}
