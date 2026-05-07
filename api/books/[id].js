import { deleteBook } from '../../src/checker.mjs';
import { handleError, requireMethod, sendJson } from '../../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['DELETE'])) return;
    await deleteBook(req.query.id);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    handleError(res, error);
  }
}
