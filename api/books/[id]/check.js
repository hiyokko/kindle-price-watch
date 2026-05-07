import { checkBookById } from '../../../src/checker.mjs';
import { handleError, requireMethod, sendJson } from '../../../src/api-utils.mjs';

export default async function handler(req, res) {
  try {
    if (!requireMethod(req, res, ['POST'])) return;
    const result = await checkBookById(req.query.id, { notify: true });
    sendJson(res, 200, {
      ...result,
      diagnostics: {
        priceProvider: process.env.PRICE_PROVIDER || 'amazon_html',
        keepaConfigured: Boolean(process.env.KEEPA_API_KEY)
      }
    });
  } catch (error) {
    handleError(res, error);
  }
}
