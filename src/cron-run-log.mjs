export function compactCronRunResult(result = {}) {
  const results = Array.isArray(result.results) ? result.results : [];
  const failures = results.filter((entry) => entry?.ok === false);
  const notificationCount = results.reduce(
    (total, entry) => total + (Array.isArray(entry?.notifications) ? entry.notifications.length : 0),
    0
  );
  const summary = { ...result };
  delete summary.results;

  return {
    ...summary,
    resultSummary: {
      total: results.length,
      succeeded: results.length - failures.length,
      failed: failures.length,
      notifications: notificationCount,
      failureSamples: failures.slice(0, 10).map((entry) => ({
        asin: entry?.book?.asin || '',
        title: entry?.book?.title || '',
        error: entry?.error || entry?.book?.lastError || ''
      }))
    }
  };
}
