export function normalizeWebhookEntries(value = []) {
  const source = Array.isArray(value) ? value : parseWebhookUrls(value);
  const seen = new Set();
  const entries = [];

  for (const item of source) {
    const entry = normalizeWebhookEntry(item);
    if (!entry || seen.has(entry.url)) continue;
    seen.add(entry.url);
    entries.push(entry);
  }
  return entries;
}

export function activeWebhookUrls(entries = []) {
  return entries.filter((entry) => entry.enabled !== false).map((entry) => entry.url);
}

export function parseWebhookUrls(value) {
  return [
    ...new Set(
      String(value || '')
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function normalizeWebhookEntry(item) {
  if (typeof item === 'string') {
    const url = item.trim();
    return url ? { name: '', url, enabled: true } : null;
  }
  if (!item || typeof item !== 'object') return null;

  const url = String(item.url || '').trim();
  if (!url) return null;
  return {
    name: String(item.name || '').trim(),
    url,
    enabled: item.enabled !== false
  };
}
