import { deleteSeries } from '../src/checker.mjs';
import { handleError, readJsonBody, requireMethod, sendJson } from '../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['DELETE'])) return;
    const body = await readJsonBody(req);
    await deleteSeries(body.seriesKey || '', body.sourceUrl || '');
    sendJson(res, 200, { ok: true });
  } catch (error) {
    handleError(res, error);
  }
}
