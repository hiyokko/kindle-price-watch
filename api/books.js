import { addBooksFromInput, deleteAllBooks, deleteBooks, listBooks } from '../src/checker.mjs';
import { handleError, readJsonBody, requireMethod, sendJson } from '../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['GET', 'POST', 'DELETE'])) return;

    if (req.method === 'GET') {
      sendJson(res, 200, { books: await listBooks() });
      return;
    }

    if (req.method === 'DELETE') {
      const body = await readJsonBody(req);
      sendJson(res, 200, body.all ? await deleteAllBooks() : await deleteBooks(body.ids || []));
      return;
    }

    const body = await readJsonBody(req);
    sendJson(res, 201, await addBooksFromInput(body.url || body.asin || ''));
  } catch (error) {
    handleError(res, error);
  }
}
