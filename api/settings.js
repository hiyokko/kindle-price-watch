import { getAutomationStatus, getDiscordWebhookCount, getSettings, saveSettings } from '../src/checker.mjs';
import { handleError, readJsonBody, requireMethod, sendJson } from '../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['GET', 'PUT'])) return;

    if (req.method === 'GET') {
      const discordWebhookCount = await getDiscordWebhookCount();
      sendJson(res, 200, {
        settings: await getSettings(),
        automation: await getAutomationStatus(),
        discordConfigured: discordWebhookCount > 0,
        discordWebhookCount,
        priceProvider: process.env.PRICE_PROVIDER || 'amazon_html',
        keepaConfigured: Boolean(process.env.KEEPA_API_KEY)
      });
      return;
    }

    sendJson(res, 200, { settings: await saveSettings(await readJsonBody(req)) });
  } catch (error) {
    handleError(res, error);
  }
}
