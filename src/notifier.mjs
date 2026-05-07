export async function sendDiscordNotification(message, options = {}) {
  const webhookUrls = options.webhookUrls || getDiscordWebhookUrls();
  if (webhookUrls.length === 0) {
    return { ok: false, skipped: true, reason: 'DISCORD_WEBHOOK_URL is not set' };
  }

  const results = await Promise.allSettled(webhookUrls.map((webhookUrl) => postDiscordWebhook(webhookUrl, message)));
  const delivered = results.filter((result) => result.status === 'fulfilled').length;
  const failed = results.length - delivered;

  if (delivered === 0) {
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason?.message || String(result.reason));
    throw new Error(errors.join(' / ') || 'Discord webhook delivery failed');
  }

  return { ok: true, delivered, failed, total: webhookUrls.length };
}

export function getDiscordWebhookUrls() {
  return parseDiscordWebhookUrls(`${process.env.DISCORD_WEBHOOK_URL || ''}\n${process.env.DISCORD_WEBHOOK_URLS || ''}`);
}

async function postDiscordWebhook(webhookUrl, message) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord HTTP ${response.status}: ${body.slice(0, 120)}`);
  }
}

export function parseDiscordWebhookUrls(value) {
  const seen = new Set();
  const urls = [];
  for (const item of String(value || '').split(/[\s,]+/)) {
    const url = item.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function buildPriceNotification(book, event) {
  const color = event.type === 'best_ever' ? 0xff6b6b : 0x4ecdc4;
  const titlePrefix = event.type === 'best_ever' ? '過去最安' : '値下げ';
  const priceLine = formatPriceLine(book);
  const dropLine = event.dropPercent != null ? `値下げ率: ${event.dropPercent}%` : null;
  const lowestLine =
    book.lowestEffectivePrice != null ? `過去最安: ${formatYen(book.lowestEffectivePrice)}` : null;

  return {
    username: 'Kindle Price Watch',
    embeds: [
      {
        title: `${titlePrefix}: ${book.title}`,
        url: book.amazonUrl,
        color,
        thumbnail: book.imageUrl ? { url: book.imageUrl } : undefined,
        fields: [
          { name: '現在', value: priceLine, inline: true },
          event.previousEffectivePrice != null
            ? { name: '前回', value: formatYen(event.previousEffectivePrice), inline: true }
            : null,
          lowestLine ? { name: '記録', value: lowestLine, inline: true } : null,
          dropLine ? { name: '変化', value: dropLine, inline: true } : null
        ].filter(Boolean),
        footer: {
          text: `${book.asin} / ${book.provider || 'unknown'}`
        },
        timestamp: new Date().toISOString()
      }
    ]
  };
}

function formatPriceLine(book) {
  if (book.currentPrice == null) return '価格を取得できませんでした';
  const base = formatYen(book.currentPrice);
  if (book.currentPoints > 0) {
    return `${base} / ${book.currentPoints.toLocaleString('ja-JP')}pt / 実質 ${formatYen(book.effectivePrice)}`;
  }
  return book.effectivePrice != null ? formatYen(book.effectivePrice) : base;
}

function formatYen(value) {
  return `¥${Number(value).toLocaleString('ja-JP')}`;
}
