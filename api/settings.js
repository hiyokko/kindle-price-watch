import { saveSettingsPayload, settingsPayload } from '../src/app-api.mjs';
import { handleError, readJsonBody, requireMethod, sendJson } from '../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['GET', 'PUT'])) return;

    if (req.method === 'GET') {
      sendJson(res, 200, await settingsPayload());
      return;
    }

    sendJson(res, 200, await saveSettingsPayload(await readJsonBody(req)));
  } catch (error) {
    handleError(res, error);
  }
}
