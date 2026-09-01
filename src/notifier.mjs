import { parseWebhookUrls } from './webhook-config.mjs';

const DEFAULT_DISCORD_WEBHOOK_SPACING_MS = 350;
const DEFAULT_DISCORD_RETRY_ATTEMPTS = 3;
const DEFAULT_DISCORD_RETRY_BASE_DELAY_MS = 750;
const DEFAULT_DISCORD_RETRY_MAX_DELAY_MS = 10_000;
const DEFAULT_DISCORD_RETRY_SAFETY_MS = 250;

const discordWebhookNextAvailableAt = new Map();

export async function sendDiscordNotification(message, options = {}) {
  const webhookUrls = options.webhookUrls || getDiscordWebhookUrls();
  if (webhookUrls.length === 0) {
    return { ok: false, skipped: true, reason: 'DISCORD_WEBHOOK_URL is not set' };
  }

  const deliveryOptions = discordDeliveryOptions(options);
  const results = await Promise.allSettled(
    webhookUrls.map(async (webhookUrl) => {
      await waitForDiscordWebhookSlot(webhookUrl, deliveryOptions);
      return postDiscordWebhook(webhookUrl, message, deliveryOptions);
    })
  );
  const delivered = results.filter((result) => result.status === 'fulfilled').length;
  const failed = results.length - delivered;
  const retryCount = results
    .filter((result) => result.status === 'fulfilled')
    .reduce((total, result) => total + Math.max(0, Number(result.value?.attempts || 1) - 1), 0);

  if (delivered === 0) {
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason?.message || String(result.reason));
    throw new Error(errors.join(' / ') || 'Discord webhook delivery failed');
  }

  return { ok: true, delivered, failed, total: webhookUrls.length, retries: retryCount };
}

export function getDiscordWebhookUrls() {
  return parseDiscordWebhookUrls(`${process.env.DISCORD_WEBHOOK_URL || ''}\n${process.env.DISCORD_WEBHOOK_URLS || ''}`);
}

async function postDiscordWebhook(webhookUrl, message, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= options.retryAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
      });
    } catch (error) {
      lastError = error;
      if (attempt < options.retryAttempts) {
        await options.sleep(retryDelayMs({ attempt, options }));
        continue;
      }
      throw error;
    }

    if (response.ok) {
      return { attempts: attempt + 1 };
    }

    const body = await response.text().catch(() => '');
    const error = new Error(`Discord HTTP ${response.status}: ${body.slice(0, 120)}`);
    lastError = error;
    if (isRetryableDiscordStatus(response.status) && attempt < options.retryAttempts) {
      await options.sleep(retryDelayMs({ response, body, attempt, options }));
      continue;
    }
    throw error;
  }

  throw lastError || new Error('Discord webhook delivery failed');
}

function discordDeliveryOptions(options = {}) {
  return {
    retryAttempts: clampInteger(
      options.retryAttempts ?? process.env.DISCORD_WEBHOOK_RETRY_ATTEMPTS,
      0,
      8,
      DEFAULT_DISCORD_RETRY_ATTEMPTS
    ),
    retryBaseDelayMs: clampInteger(
      options.retryBaseDelayMs ?? process.env.DISCORD_WEBHOOK_RETRY_BASE_MS,
      100,
      60_000,
      DEFAULT_DISCORD_RETRY_BASE_DELAY_MS
    ),
    retryMaxDelayMs: clampInteger(
      options.retryMaxDelayMs ?? process.env.DISCORD_WEBHOOK_RETRY_MAX_MS,
      100,
      120_000,
      DEFAULT_DISCORD_RETRY_MAX_DELAY_MS
    ),
    retrySafetyMs: clampInteger(
      options.retrySafetyMs ?? process.env.DISCORD_WEBHOOK_RETRY_SAFETY_MS,
      0,
      10_000,
      DEFAULT_DISCORD_RETRY_SAFETY_MS
    ),
    webhookSpacingMs: clampInteger(
      options.webhookSpacingMs ?? process.env.DISCORD_WEBHOOK_SPACING_MS,
      0,
      10_000,
      DEFAULT_DISCORD_WEBHOOK_SPACING_MS
    ),
    sleep: typeof options.sleep === 'function' ? options.sleep : sleep
  };
}

async function waitForDiscordWebhookSlot(webhookUrl, options) {
  if (options.webhookSpacingMs <= 0) return;

  const now = Date.now();
  const reservedAt = Math.max(now, discordWebhookNextAvailableAt.get(webhookUrl) || 0);
  discordWebhookNextAvailableAt.set(webhookUrl, reservedAt + options.webhookSpacingMs);

  const waitMs = reservedAt - now;
  if (waitMs > 0) await options.sleep(waitMs);
}

function isRetryableDiscordStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function retryDelayMs({ response, body, attempt, options }) {
  const explicitDelayMs = response ? discordRetryAfterMs(response, body) : null;
  if (explicitDelayMs != null) return Math.min(options.retryMaxDelayMs, explicitDelayMs + options.retrySafetyMs);

  const exponentialDelay = options.retryBaseDelayMs * (2 ** attempt);
  return Math.min(options.retryMaxDelayMs, exponentialDelay + options.retrySafetyMs);
}

function discordRetryAfterMs(response, body) {
  const headerDelay =
    parseDiscordDelaySeconds(response.headers.get('retry-after')) ??
    parseDiscordDelaySeconds(response.headers.get('x-ratelimit-reset-after'));
  if (headerDelay != null) return headerDelay;

  try {
    const parsed = JSON.parse(body);
    return parseDiscordDelaySeconds(parsed?.retry_after);
  } catch {
    return null;
  }
}

function parseDiscordDelaySeconds(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 1000);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms || 0))));
}

export function parseDiscordWebhookUrls(value) {
  return parseWebhookUrls(value);
}

export function buildPriceNotification(book, event) {
  const color = event.type === 'best_ever' ? 0xff6b6b : 0x4ecdc4;
  const titlePrefix = event.type === 'best_ever' ? '過去最安' : '値下げ';
  const priceLine = formatPriceLine(book);
  const dropLine = event.dropPercent != null ? `値下げ率: ${event.dropPercent}%` : null;
  const lowestLine =
    book.lowestEffectivePrice != null ? `過去最安: ${formatYen(book.lowestEffectivePrice)}` : null;
  const isSeries = book.notificationScope === 'series' || event.scope === 'series';
  const averageEffectiveLine = isSeries ? formatAverageSeriesEffectiveLine(book) : null;
  const seriesTargetLine = isSeries ? formatSeriesTargetLine(book, averageEffectiveLine) : null;
  const title = isSeries ? book.seriesName || book.title : book.title;
  const footerText = isSeries
    ? `${Number(book.bookCount || 0).toLocaleString('ja-JP')}冊合計 / ${book.provider || 'series_total'}`
    : `${book.asin} / ${book.provider || 'unknown'}`;

  return {
    username: 'Kindle Price Watch',
    embeds: [
      {
        title: `${titlePrefix}: ${title}`,
        url: book.amazonUrl,
        color,
        thumbnail: book.imageUrl ? { url: book.imageUrl } : undefined,
        fields: [
          { name: '現在', value: priceLine, inline: true },
          event.previousEffectivePrice != null
            ? { name: '前回', value: formatYen(event.previousEffectivePrice), inline: true }
            : null,
          seriesTargetLine ? { name: '対象', value: seriesTargetLine, inline: true } : null,
          lowestLine ? { name: '記録', value: lowestLine, inline: true } : null,
          dropLine ? { name: '変化', value: dropLine, inline: true } : null
        ].filter(Boolean),
        footer: {
          text: footerText
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
    resultErrors > 0 && Array.isArray(summary.checkErrorBreakdown) && summary.checkErrorBreakdown.length > 0
      ? {
          name: '取得エラー内訳',
          value: summary.checkErrorBreakdown
            .slice(0, 5)
            .map((entry) => `${entry.reason}: ${Number(entry.count || 0).toLocaleString('ja-JP')}`)
            .join('\n'),
          inline: false
        }
      : null,
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
    summary.singleSeriesAudit
      ? {
          name: '単巻分類監査',
          value: `対象 ${Number(summary.singleSeriesAudit.eligible || 0).toLocaleString('ja-JP')} / 確認 ${Number(summary.singleSeriesAudit.checked || 0).toLocaleString('ja-JP')} / シリーズ化 ${Number(summary.singleSeriesAudit.converted || 0).toLocaleString('ja-JP')} / 追加 ${Number(summary.singleSeriesAudit.added || 0).toLocaleString('ja-JP')} / 単巻維持 ${Number(summary.singleSeriesAudit.noSeries || 0).toLocaleString('ja-JP')} / エラー ${Number(summary.singleSeriesAudit.errors || 0).toLocaleString('ja-JP')}`,
          inline: false
        }
      : null,
    summary.seriesDiscovery
      ? {
          name: 'シリーズ探索',
          value: seriesDiscoverySummaryText(summary.seriesDiscovery),
          inline: false
        }
      : null,
    summary.listPriceChallenge
      ? {
          name: 'listPrice補完',
          value: listPriceChallengeSummaryText(summary.listPriceChallenge),
          inline: false
        }
      : null,
    summary.priceIntegrityAudit
      ? {
          name: '価格監査',
          value: `確認 ${Number(summary.priceIntegrityAudit.checked || 0).toLocaleString('ja-JP')} / 異常 ${Number(summary.priceIntegrityAudit.suspicious || 0).toLocaleString('ja-JP')} / 警告 ${Number(summary.priceIntegrityAudit.warnings || 0).toLocaleString('ja-JP')} / 修復 ${Number(summary.priceIntegrityAudit.repaired || 0).toLocaleString('ja-JP')} / 未解決 ${Number(summary.priceIntegrityAudit.unresolved || 0).toLocaleString('ja-JP')}`,
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

function seriesDiscoverySummaryText(summary = {}) {
  const text = `確認 ${Number(summary.checked || 0).toLocaleString('ja-JP')} / 新規 ${Number(summary.added || 0).toLocaleString('ja-JP')} / 実行なし ${Number(summary.skippedNoRun || 0).toLocaleString('ja-JP')} / 保留 ${Number(summary.deferred || 0).toLocaleString('ja-JP')} / エラー ${Number(summary.errors || 0).toLocaleString('ja-JP')}`;
  const queued = Number(summary.followUpQueued || 0);
  if (queued <= 0) return text;
  return `${text}\n新刊即時確認: 対象 ${queued.toLocaleString('ja-JP')} / 成功 ${Number(summary.followUpSucceeded || 0).toLocaleString('ja-JP')} / 失敗 ${Number(summary.followUpFailed || 0).toLocaleString('ja-JP')}`;
}

function listPriceChallengeSummaryText(summary = {}) {
  const parts = [
    `対象 ${Number(summary.eligible || 0).toLocaleString('ja-JP')}`,
    `試行 ${Number(summary.attempted || 0).toLocaleString('ja-JP')}`,
    `保存 ${Number(summary.updated || 0).toLocaleString('ja-JP')}`,
    `未検出 ${Number(summary.notFound || 0).toLocaleString('ja-JP')}`,
    `除外 ${Number(summary.rejected || 0).toLocaleString('ja-JP')}`,
    `エラー ${Number(summary.errors || 0).toLocaleString('ja-JP')}`
  ];
  let insertionIndex = 3;
  if (Number(summary.observedFallback || 0) > 0) {
    parts.splice(insertionIndex, 0, `履歴補完 ${Number(summary.observedFallback || 0).toLocaleString('ja-JP')}`);
    insertionIndex += 1;
  }
  if (Number(summary.peerFallback || 0) > 0) {
    parts.splice(insertionIndex, 0, `同シリーズ補完 ${Number(summary.peerFallback || 0).toLocaleString('ja-JP')}`);
  }
  if (Number(summary.skippedByLimit || 0) > 0) {
    parts.push(`上限超過 ${Number(summary.skippedByLimit || 0).toLocaleString('ja-JP')}`);
  }
  if (Number(summary.skippedRecentNotFound || 0) > 0) {
    parts.push(`再試行待ち ${Number(summary.skippedRecentNotFound || 0).toLocaleString('ja-JP')}`);
  }
  if (summary.stoppedByRuntimeLimit) parts.push('時間切れ');

  const rejectionText = Array.isArray(summary.rejectionBreakdown) && summary.rejectionBreakdown.length > 0
    ? `\n除外内訳: ${summary.rejectionBreakdown
        .slice(0, 3)
        .map((entry) => `${listPriceChallengeRejectionLabel(entry.reason)} ${Number(entry.count || 0).toLocaleString('ja-JP')}`)
        .join(' / ')}`
    : '';
  const notFoundText = Array.isArray(summary.notFoundSamples) && summary.notFoundSamples.length > 0
    ? `\n未検出例: ${summary.notFoundSamples
        .slice(0, 3)
        .map((entry) => compactSummaryTitle(entry.title || entry.asin || '不明'))
        .join(' / ')}`
    : '';
  return `${parts.join(' / ')}${rejectionText}${notFoundText}`;
}

function listPriceChallengeRejectionLabel(reason = '') {
  const labels = {
    list_price_missing: 'listPriceなし',
    current_price_missing: '現在価格なし',
    not_above_current_price: '現在価格以下',
    above_price_history: '履歴上限超過',
    below_price_history: '履歴下限割れ'
  };
  return labels[reason] || reason || '除外';
}

function compactSummaryTitle(value = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 26 ? `${text.slice(0, 25)}…` : text;
}

function formatPriceLine(book) {
  if (book.currentPrice == null) return '価格を取得できませんでした';
  const base = formatYen(book.currentPrice);
  if (book.currentPoints > 0) {
    return `${base} / ${book.currentPoints.toLocaleString('ja-JP')}pt / 実質 ${formatYen(book.effectivePrice)}`;
  }
  return book.effectivePrice != null ? formatYen(book.effectivePrice) : base;
}

function formatAverageSeriesEffectiveLine(book) {
  const bookCount = Number(book.bookCount || 0);
  const effectiveTotal = Number(book.effectivePrice);
  if (!Number.isFinite(bookCount) || bookCount <= 0 || !Number.isFinite(effectiveTotal)) return '';
  return `${formatYen(Math.round(effectiveTotal / bookCount))} / 冊`;
}

function formatSeriesTargetLine(book, averageEffectiveLine) {
  const countLine = `${Number(book.bookCount || 0).toLocaleString('ja-JP')}冊合計`;
  return averageEffectiveLine ? `${countLine}\n平均実質 ${averageEffectiveLine}` : countLine;
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
