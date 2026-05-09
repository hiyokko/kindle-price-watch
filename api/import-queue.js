import { importQueuePayload, saveImportQueuePayload } from '../src/app-api.mjs';
import { handleError, readJsonBody, requireMethod, sendJson } from '../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['GET', 'PUT', 'POST'])) return;

    if (req.method === 'GET') {
      sendJson(res, 200, await importQueuePayload());
      return;
    }

    sendJson(res, 200, await saveImportQueuePayload(await readJsonBody(req)));
  } catch (error) {
    handleError(res, error);
  }
}
