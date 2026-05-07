import { getDiscordWebhooks, saveDiscordWebhooks } from '../src/checker.mjs';
import { handleError, readJsonBody, requireMethod, sendJson } from '../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['GET', 'PUT'])) return;

    if (req.method === 'GET') {
      sendJson(res, 200, await getDiscordWebhooks());
      return;
    }

    const body = await readJsonBody(req);
    sendJson(res, 200, await saveDiscordWebhooks(body.urls || []));
  } catch (error) {
    handleError(res, error);
  }
}
