import { latestJstExecutionBoundaryMs, scheduledExecutionTimes, todayJstExecutionBoundaryMs } from './scheduler.mjs';

const DISCOUNT_RECHECK_DEFAULT_HOURS = 24;
const DISCOUNT_RECHECK_RATIO = 0.7;
const UNVALIDATED_SERIES_PRICE_PROVIDERS = new Set([
  'amazon_series_source_price',
  'amazon_series_unit_price',
  'efox_series',
  'external_series',
  'kinpome_series',
  'kintyaku_series',
  'sale_bon_series'
]);

export function isPermanentSnapshotError(error) {
  return /^Kindle版(?:ASIN|商品)ではありません/.test(String(error || ''));
}

export function isTransientSnapshotError(error) {
  return /(?:価格を取得できませんでした|Amazonにブロック|HTTP\s*(?:403|429|500|503)|fetch failed|タイムアウト|reader:|商品ページではなくエラーページ)/i.test(String(error || ''));
}

export function isBlockingSnapshotError(error) {
  return /(?:HTTP\s*(?:403|429|503)|Too Many Requests|Forbidden|ServiceUnavailable|サービスが利用できません|Amazonにブロック|captcha|robot check|自動化されたアクセス|ショッピングを続けてください)/i.test(String(error || ''));
}

export function isUnvalidatedSeriesPriceProvider(provider) {
  return UNVALIDATED_SERIES_PRICE_PROVIDERS.has(String(provider || '').toLowerCase());
}

export function isUnverifiedFreeSeriesPriceProvider(provider, currentPrice) {
  const price = Number(currentPrice);
  if (!Number.isFinite(price) || price !== 0) return false;
  const normalized = String(provider || '').toLowerCase();
  if (['amazon_html', 'amazon_reader', 'listasin', 'keepa'].includes(normalized)) return false;
  return isSeriesDerivedPriceProvider(normalized);
}

export function isSeriesDerivedPriceProvider(provider) {
  const normalized = String(provider || '').toLowerCase();
  return normalized.includes('_series') || normalized === 'amazon_series_bulk' || normalized === 'amazon_series_reader';
}

export function seriesAggregateFreshAfter(now = Date.now()) {
  const timestamp = Number(now);
  const base = Number.isFinite(timestamp) ? timestamp : Date.now();
  return new Date(recentJstExecutionBoundaryMs(base, seriesAggregateObservationRuns()));
}

function recentJstExecutionBoundaryMs(now, runCount = 5) {
  const count = floorNumber(runCount, 1, 5);
  const dayMs = 24 * 60 * 60 * 1000;
  const times = scheduledExecutionTimes().sort(
    (left, right) => left.hour * 60 + left.minute - (right.hour * 60 + right.minute)
  );
  const boundaries = [];

  for (let dayOffset = 0; boundaries.length < count && dayOffset <= count; dayOffset += 1) {
    for (const time of [...times].reverse()) {
      const boundary = todayJstExecutionBoundaryMs(now, time) - dayOffset * dayMs;
      if (boundary <= now) boundaries.push(boundary);
      if (boundaries.length >= count) break;
    }
  }

  return boundaries[count - 1] ?? latestJstExecutionBoundaryMs(now);
}

function seriesAggregateObservationRuns() {
  return floorNumber(process.env.SERIES_TOTAL_OBSERVATION_RUNS, 1, 5);
}

export function needsBookImageRefresh(book) {
  if (hasBookImage(book)) return false;
  if (isPermanentSnapshotError(book?.lastError)) return false;
  return true;
}

function hasBookImage(book) {
  return Boolean(book?.imageUrl || book?.imageKey);
}

export function needsSeriesAggregateRefresh(book, freshAfterMs) {
  if (!hasTrustedCurrentPrice(book)) return true;
  const checkedAt = timestampMs(book.lastCheckedAt);
  return checkedAt <= 0 || checkedAt < freshAfterMs;
}

export function hasTrustedCurrentPrice(book) {
  return (
    book?.currentPrice != null &&
    book?.effectivePrice != null &&
    !isUnvalidatedSeriesPriceProvider(book.provider) &&
    !isUnverifiedFreeSeriesPriceProvider(book.provider, book.currentPrice)
  );
}

export function isDiscardedUnvalidatedSeriesPrice(book) {
  return String(book?.lastError || '').includes('未検証のシリーズ価格を破棄しました');
}

export function isBookStaleForPriority(book, now) {
  const checkedAt = new Date(book?.lastCheckedAt || 0).getTime();
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return true;
  return now - checkedAt >= 3 * 24 * 60 * 60 * 1000;
}

export function needsDiscountExpiryRecheck(book, now = Date.now()) {
  if (!hasTrustedCurrentPrice(book)) return false;

  const checkedAt = new Date(book?.lastCheckedAt || 0).getTime();
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return true;

  const ageMs = now - checkedAt;
  const thresholdHours = floorNumber(process.env.DISCOUNT_RECHECK_HOURS, 1, DISCOUNT_RECHECK_DEFAULT_HOURS);
  if (ageMs < thresholdHours * 60 * 60 * 1000) return false;

  const effective = nullableNumber(book.effectivePrice ?? book.currentPrice);
  const listPrice = nullableNumber(trustedListPriceFor(book.currentPrice, book.listPrice, book.provider));
  if (effective == null || effective <= 0 || listPrice == null || listPrice <= 0) return false;

  return effective <= listPrice * DISCOUNT_RECHECK_RATIO;
}

export function isCheckRetryCoolingDown(book, now) {
  if (!isTransientSnapshotError(book?.lastError) && !isBlockingSnapshotError(book?.lastError)) return false;
  if (isDiscardedUnvalidatedSeriesPrice(book)) return false;
  if (book?.currentPrice == null && !book?.lastCheckedAt) return false;

  const checkedAt = new Date(book.lastCheckedAt || book.updatedAt || book.createdAt || 0).getTime();
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return false;
  return now - checkedAt < checkRetryCooldownMs(book);
}

function checkRetryCooldownMs(book) {
  const fallbackHours = isBlockingSnapshotError(book?.lastError) ? 12 : 3;
  return floorNumber(process.env.CHECK_RETRY_COOLDOWN_HOURS, 0, fallbackHours) * 60 * 60 * 1000;
}

function timestampMs(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function nullableNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function floorNumber(value, min, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.round(number));
}

function trustedListPriceFor(_currentPrice, listPrice, provider) {
  return isSeriesDerivedPriceProvider(provider) ? null : listPrice ?? null;
}
