const ASIN_PATTERN = /[A-Z0-9]{10}/i;

export function extractAsin(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  const direct = value.match(/^[A-Z0-9]{10}$/i);
  if (direct) return direct[0].toUpperCase();

  try {
    const url = new URL(value);
    const pathMatch = url.pathname.match(
      /\/(?:dp|gp\/product|exec\/obidos\/ASIN|kindle-dbs\/product)\/([A-Z0-9]{10})/i
    );
    if (pathMatch) return pathMatch[1].toUpperCase();

    for (const key of ['asin', 'ASIN']) {
      const param = url.searchParams.get(key);
      if (param && ASIN_PATTERN.test(param)) {
        return param.match(ASIN_PATTERN)[0].toUpperCase();
      }
    }
  } catch {
    const anywhere = value.match(ASIN_PATTERN);
    if (anywhere) return anywhere[0].toUpperCase();
  }

  return null;
}

export function amazonUrlForAsin(asin) {
  const host = process.env.AMAZON_HOST || 'www.amazon.co.jp';
  return `https://${host}/dp/${asin}`;
}

export function isKindleSeriesUrl(input) {
  try {
    const url = new URL(String(input || '').trim());
    const ref = `${url.searchParams.get('ref') || ''} ${url.searchParams.get('ref_') || ''}`;
    return (
      /\/series\//i.test(url.pathname) ||
      /\/kindle-dbs\/product\/[A-Z0-9]{10}/i.test(url.pathname) ||
      /dbs_|dbs-|saga_sdp|hulkbuy|dbs_dp_rwt_sb_pc_tkin|dbs_s_ks_series_rwt_tkin/i.test(ref)
    );
  } catch {
    return false;
  }
}
