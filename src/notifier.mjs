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

export function buildCronSummaryNotification(summary = {}) {
  const startedAt = summary.startedAt ? new Date(summary.startedAt) : null;
  const finishedAt = summary.finishedAt ? new Date(summary.finishedAt) : new Date();
  const durationMs = Number(summary.durationMs || 0);
  const checked = Number(summary.checked || 0);
  const remainingDue = Number(summary.remainingDue || 0);
  const resultErrors = Number(summary.resultErrors || 0);
  const notificationSent = Number(summary.notificationSent || 0);
  const notificationFailed = Number(summary.notificationFailed || 0);
  const status = summary.stoppedByRuntimeLimit ? 'ランタイム上限で停止' : '完了';
  const color = summary.stoppedByRuntimeLimit ? 0xffc857 : resultErrors > 0 ? 0xff9f1c : 0x4ecdc4;

  const fields = [
    { name: '処理冊数', value: `${checked.toLocaleString('ja-JP')}冊`, inline: true },
    { name: '実行時間', value: formatDuration(durationMs), inline: true },
    { name: '残件', value: `${remainingDue.toLocaleString('ja-JP')}冊`, inline: true },
    resultErrors > 0 ? { name: '取得エラー', value: `${resultErrors.toLocaleString('ja-JP')}冊`, inline: true } : null,
    notificationSent + notificationFailed > 0
      ? {
          name: '価格通知',
          value: `成功 ${notificationSent.toLocaleString('ja-JP')} / 失敗 ${notificationFailed.toLocaleString('ja-JP')}`,
          inline: true
        }
      : null,
    summary.importQueue
      ? {
          name: '追加キュー',
          value: `処理 ${Number(summary.importQueue.processed || 0).toLocaleString('ja-JP')} / 追加 ${Number(summary.importQueue.imported || 0).toLocaleString('ja-JP')} / エラー ${Number(summary.importQueue.errors || 0).toLocaleString('ja-JP')}`,
          inline: false
        }
      : null,
    summary.seriesDiscovery
      ? {
          name: 'シリーズ探索',
          value: `確認 ${Number(summary.seriesDiscovery.checked || 0).toLocaleString('ja-JP')} / 新規 ${Number(summary.seriesDiscovery.added || 0).toLocaleString('ja-JP')} / エラー ${Number(summary.seriesDiscovery.errors || 0).toLocaleString('ja-JP')}`,
          inline: false
        }
      : null
  ].filter(Boolean);

  return {
    username: 'Kindle Price Watch',
    embeds: [
      {
        title: `自動実行サマリー: ${status}`,
        color,
        fields,
        footer: {
          text: `source: ${summary.source || 'cron'}${summary.forced ? ' / forced' : ''}`
        },
        timestamp: finishedAt.toISOString(),
        description: startedAt
          ? `開始: ${formatDateTime(startedAt)}\n終了: ${formatDateTime(finishedAt)}`
          : `終了: ${formatDateTime(finishedAt)}`
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

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}時間${minutes}分${seconds}秒`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}
