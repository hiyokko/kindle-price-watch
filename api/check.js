import { runDueChecks } from '../src/checker.mjs';
import { handleError, requireMethod, sendJson } from '../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['POST'])) return;
    sendJson(res, 200, await runDueChecks({ notify: true }));
  } catch (error) {
    handleError(res, error);
  }
}
