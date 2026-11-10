import { latestJstExecutionBoundaryMs } from './scheduler.mjs';
import { notificationSeriesScope } from './series-identity.mjs';
import {
  hasTrustedCurrentPrice, isBlockingSnapshotError, isCheckRetryCoolingDown,
  isDiscardedUnvalidatedSeriesPrice, isBookStaleForPriority, isTransientSnapshotError,
  needsBookImageRefresh, needsDiscountExpiryRecheck, needsSeriesAggregateRefresh,
  seriesAggregateFreshAfter
} from './check-policy.mjs';

export function planDueChecks(store, settings, now, options = {}) {
  const rotatedBooks = rotateAfterCursor(store.books, store.checkCursor?.lastBookId);
  const priorityContext = checkPriorityContext(rotatedBooks, now);
  const limit = Math.max(1, Math.round(Number(settings.batchSize) || 50));
  const dueBefore = Number.isFinite(options.dueCutoffMs)
    ? options.dueCutoffMs
    : scheduledDueCutoffMs(now);
  const dueBooks = options.forceAll ? rotatedBooks : rotatedBooks.filter(
    (book) => isAutoCheckCandidate(book, dueBefore) && !isCheckRetryCoolingDown(book, now)
  );
  const overdueHours = checkOverdueHours(options.overdueHours);
  const overdueBooks = dueBooks.filter((book) => isOverdueForCheck(book, now, overdueHours))
    .sort((left, right) => checkAgeAnchorMs(left) - checkAgeAnchorMs(right));
  const protectedBooks = overdueBooks.slice(0, limit);
  const orderedDueBooks = orderCheckCandidates(dueBooks, priorityContext, now);
  const protectedIds = new Set(protectedBooks.map((book) => book.id));
  // Reserve the oldest prefix before adding series siblings or newly discovered releases.
  const selected = options.forceAll
    ? [...protectedBooks, ...orderedDueBooks.filter((book) => !protectedIds.has(book.id))].slice(0, limit)
    : selectCheckCandidatesWithSeriesCompletion(orderedDueBooks, priorityContext, now, limit, protectedBooks);
  const dueSelected = options.forceAll ? selected.length : selected.filter((book) => isBookDue(book, dueBefore)).length;

  if (dueBooks.length > 0 && selected.length < limit) {
    const selectedIds = new Set(selected.map((book) => book.id));
    const fillerBooks = orderCheckCandidates(
      rotatedBooks.filter((book) => !isCheckRetryCoolingDown(book, now)),
      priorityContext,
      now
    );
    for (const book of fillerBooks) {
      if (selected.length >= limit) break;
      if (selectedIds.has(book.id) || isAutoCheckCandidate(book, dueBefore)) continue;
      selected.push(book);
      selectedIds.add(book.id);
    }
  }

  return {
    books: selected,
    dueSelected,
    overdueBookIds: protectedIds,
    summary: {
      overdueHours,
      planned: selected.length,
      overdueCandidates: overdueBooks.length,
      overdueSelected: protectedBooks.length,
      oldestPendingAt: overdueBooks.length ? new Date(checkAgeAnchorMs(overdueBooks[0])).toISOString() : null
    }
  };
}

function selectCheckCandidatesWithSeriesCompletion(orderedBooks, context, now, limit, priorityBooks = []) {
  const selected = [...priorityBooks];
  const selectedIds = new Set(selected.map((book) => book.id));

  for (const book of orderedBooks) {
    if (selected.length >= limit) break;
    if (selectedIds.has(book.id)) continue;

    selected.push(book);
    selectedIds.add(book.id);

    const completionBooks = seriesCompletionBooksForPlan(book, context, now, selectedIds);
    if (completionBooks.length === 0 || completionBooks.length > limit - selected.length) continue;

    for (const completionBook of completionBooks) {
      selected.push(completionBook);
      selectedIds.add(completionBook.id);
    }
  }

  return selected;
}

function seriesCompletionBooksForPlan(book, context, now, selectedIds) {
  const scope = notificationSeriesScope(book);
  if (!scope) return [];
  const group = context.series.get(scope.key);
  if (!group || group.aggregateMissing <= 0) return [];

  const candidates = group.books.filter((candidate) => {
    if (selectedIds.has(candidate.id)) return false;
    if (isCheckRetryCoolingDown(candidate, now)) return false;
    return needsSeriesAggregateRefresh(candidate, context.seriesFreshAfterMs);
  });

  return orderCheckCandidates(candidates, context, now);
}

function checkPriorityContext(books, now) {
  const series = new Map();
  const rotatedIndex = new Map();
  const seriesFreshAfterMs = seriesAggregateFreshAfter(now).getTime();

  for (const [index, book] of books.entries()) {
    rotatedIndex.set(book.id, index);
    const scope = notificationSeriesScope(book);
    if (!scope) continue;

    const key = scope.key;
    if (!series.has(key)) {
      series.set(key, {
        total: 0,
        priced: 0,
        unpriced: 0,
        stale: 0,
        aggregateMissing: 0,
        books: []
      });
    }
    const group = series.get(key);
    group.books.push(book);
    group.total += 1;
    if (hasTrustedCurrentPrice(book)) {
      group.priced += 1;
    } else {
      group.unpriced += 1;
    }
    if (isBookStaleForPriority(book, now)) group.stale += 1;
    if (needsSeriesAggregateRefresh(book, seriesFreshAfterMs)) group.aggregateMissing += 1;
  }

  return { series, rotatedIndex, seriesFreshAfterMs };
}

function orderCheckCandidates(books, context, now) {
  return [...books].sort((left, right) => {
    const scoreDiff = checkPriorityScore(right, context, now) - checkPriorityScore(left, context, now);
    if (scoreDiff !== 0) return scoreDiff;
    return (context.rotatedIndex.get(left.id) ?? 0) - (context.rotatedIndex.get(right.id) ?? 0);
  });
}

function checkPriorityScore(book, context, now) {
  let score = 0;
  if (!hasTrustedCurrentPrice(book)) score += 100000;
  if (needsBookImageRefresh(book)) score += 60000;
  if (isDiscardedUnvalidatedSeriesPrice(book)) score += 25000;
  if (!book.lastCheckedAt) score += 12000;
  if (needsDiscountExpiryRecheck(book, now)) score += 45000;
  if (isBookStaleForPriority(book, now)) score += 2500;
  if (isTransientSnapshotError(book.lastError) && !isBlockingSnapshotError(book.lastError)) score += 1500;

  const scope = notificationSeriesScope(book);
  const series = scope ? context.series.get(scope.key) : null;
  if (series?.unpriced > 0) score += 10000 + Math.min(series.unpriced, 1000);
  if (series?.stale > 0) score += 1000 + Math.min(series.stale, 500);
  if (series?.aggregateMissing > 0) {
    if (needsSeriesAggregateRefresh(book, context.seriesFreshAfterMs)) score += 8000;
    score += Math.max(0, 3000 - series.aggregateMissing * 30);
  }

  if (isBlockingSnapshotError(book.lastError) && !hasTrustedCurrentPrice(book)) score -= 5000;
  return score;
}

function isAutoCheckCandidate(book, dueBefore) {
  return isBookDue(book, dueBefore) || needsBookImageRefresh(book);
}

function rotateAfterCursor(books, lastBookId = '') {
  if (!Array.isArray(books) || books.length === 0) return [];
  const cursorIndex = books.findIndex((book) => book.id === lastBookId);
  if (cursorIndex === -1 || cursorIndex === books.length - 1) return [...books];
  return [...books.slice(cursorIndex + 1), ...books.slice(0, cursorIndex + 1)];
}

export function countDueBooks(books, now) {
  const dueBefore = scheduledDueCutoffMs(now);
  return books.filter((book) => isBookDue(book, dueBefore)).length;
}

function isBookDue(book, dueBefore) {
  if (!book.lastCheckedAt) return true;
  const checkedAt = new Date(book.lastCheckedAt).getTime();
  return !Number.isFinite(checkedAt) || checkedAt <= dueBefore;
}

function scheduledDueCutoffMs(now) {
  return latestJstExecutionBoundaryMs(now);
}

function timestampMs(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function checkOverdueHours(value = process.env.CHECK_OVERDUE_HOURS) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 1 ? Math.min(168, hours) : 48;
}

export function isOverdueForCheck(book, now, hours = checkOverdueHours()) {
  return now - checkAgeAnchorMs(book) >= hours * 60 * 60 * 1000;
}

export function checkPlanPreview(store, settings, now = Date.now()) {
  const plan = planDueChecks(store, settings, now);
  return {
    ...plan.summary,
    nextBooks: plan.books.slice(0, 20).map((book) => ({
      asin: book.asin,
      title: book.title,
      lastCheckedAt: book.lastCheckedAt || null,
      overdue: plan.overdueBookIds.has(book.id)
    }))
  };
}

function checkAgeAnchorMs(book) {
  return timestampMs(book.lastCheckedAt) || timestampMs(book.createdAt) || timestampMs(book.updatedAt);
}
