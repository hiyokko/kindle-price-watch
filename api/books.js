import { addBooksPayload, deleteBooksPayload, listBooksPayload } from '../src/app-api.mjs';
import { handleError, readJsonBody, requireMethod, sendJson } from '../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['GET', 'POST', 'DELETE'])) return;

    if (req.method === 'GET') {
      sendJson(res, 200, await listBooksPayload());
      return;
    }

    if (req.method === 'DELETE') {
      sendJson(res, 200, await deleteBooksPayload(await readJsonBody(req)));
      return;
    }

    sendJson(res, 201, await addBooksPayload(await readJsonBody(req)));
  } catch (error) {
    handleError(res, error);
  }
}
