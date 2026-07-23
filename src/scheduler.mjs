const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAILY_CRON_EXECUTION_WINDOWS = new Map([
  ['54 18 * * *', { targetIndex: 0, backup: false }],
  ['54 6 * * *', { targetIndex: 1, backup: false }]
]);

export function resolveCronScheduleIntent(scheduleCron, now = Date.now()) {
  const normalized = normalizeScheduleCron(scheduleCron);
  if (!normalized) return null;

  const definition = DAILY_CRON_EXECUTION_WINDOWS.get(normalized);
  if (!definition) return null;

  const parsed = parseDailyUtcCron(normalized);
  if (!parsed) return null;

  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) return null;

  const times = scheduledExecutionTimes();
  const target = times[definition.targetIndex];
  if (!target) return null;

  const nominalMs = latestDailyUtcCronOccurrenceMs(nowMs, parsed.hour, parsed.minute);
  const nominalJstDayStartMs = jstDayStartUtcMs(nominalMs);
  const executionBoundaryMs =
    nominalJstDayStartMs + target.hour * 60 * 60 * 1000 + target.minute * 60 * 1000;
  const nextExecutionBoundaryMs = nextJstExecutionBoundaryAfterMs(executionBoundaryMs);

  return {
    scheduleCron: normalized,
    backup: definition.backup,
    nominalAt: new Date(nominalMs).toISOString(),
    executionBoundaryMs,
    executionBoundaryAt: new Date(executionBoundaryMs).toISOString(),
    nextExecutionBoundaryMs,
    nextExecutionBoundaryAt: new Date(nextExecutionBoundaryMs).toISOString(),
    stale: nowMs >= nextExecutionBoundaryMs
  };
}

export function cronWindowCompletionState(automation = {}, executionBoundaryMs) {
  const boundaryMs = Number(executionBoundaryMs);
  if (!Number.isFinite(boundaryMs)) {
    return completionState(automation);
  }

  const lastFinishedMs = timestampMs(automation.lastCronFinishedAt);
  const lastBoundaryMs = timestampMs(automation.lastCronExecutionBoundaryAt);
  const lastCronError = String(automation.lastCronError || '').trim();
  const lastCronStoppedByRuntimeLimit = Boolean(automation.lastCronStoppedByRuntimeLimit);
  const nextBoundaryMs = nextJstExecutionBoundaryAfterMs(boundaryMs);
  const hasExplicitSameWindow = lastBoundaryMs === boundaryMs;
  const hasLegacySameWindow =
    !lastBoundaryMs && lastFinishedMs >= boundaryMs && lastFinishedMs < nextBoundaryMs;
  const hasSameWindowCompletion =
    (hasExplicitSameWindow || hasLegacySameWindow) && lastFinishedMs >= boundaryMs;
  const hasSuccessfulCompletion = hasSameWindowCompletion && !lastCronError;
  const hasSavedRuntimeLimitCompletion =
    hasSameWindowCompletion && lastCronStoppedByRuntimeLimit && !lastCronError;

  return completionState(automation, {
    shouldSkip: hasSuccessfulCompletion || hasSavedRuntimeLimitCompletion,
    skipDetail: hasSavedRuntimeLimitCompletion
      ? 'saved_runtime_limit'
      : hasSuccessfulCompletion
        ? 'successful_completion'
        : '',
    executionBoundaryAt: new Date(boundaryMs).toISOString()
  });
}

export function backupCronSkipState(automation = {}, now = Date.now(), executionBoundaryMs = null) {
  const boundaryMs = Number.isFinite(executionBoundaryMs)
    ? executionBoundaryMs
    : latestJstExecutionBoundaryMs(now);
  return cronWindowCompletionState(automation, boundaryMs);
}

export function latestJstExecutionBoundaryMs(now) {
  const todayBoundaries = scheduledExecutionTimes().map((time) =>
    todayJstExecutionBoundaryMs(now, time)
  );
  const latestToday = [...todayBoundaries].reverse().find((boundary) => now >= boundary);
  return latestToday ?? todayBoundaries[todayBoundaries.length - 1] - DAY_MS;
}

export function nextJstExecutionBoundaryMs(now) {
  const todayBoundaries = scheduledExecutionTimes().map((time) =>
    todayJstExecutionBoundaryMs(now, time)
  );
  return todayBoundaries.find((boundary) => now < boundary) || todayBoundaries[0] + DAY_MS;
}

export function todayJstExecutionBoundaryMs(now, time) {
  const jstDayStartUtc = jstDayStartUtcMs(Number(now));
  return jstDayStartUtc + time.hour * 60 * 60 * 1000 + time.minute * 60 * 1000;
}

export function scheduledExecutionTimes() {
  return [
    { hour: 3, minute: 54 },
    { hour: 15, minute: 54 }
  ];
}

export function scheduledExecutionGraceMs() {
  return floorNumber(process.env.CHECK_EXECUTION_GRACE_MINUTES, 1, 180) * 60 * 1000;
}

export function jstDayStartUtcMs(timestamp) {
  return Math.floor((Number(timestamp) + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
}

function completionState(automation, overrides = {}) {
  return {
    shouldSkip: false,
    skipDetail: '',
    executionBoundaryAt: '',
    lastCronExecutionBoundaryAt: automation?.lastCronExecutionBoundaryAt || '',
    lastCronStartedAt: automation?.lastCronStartedAt || '',
    lastCronFinishedAt: automation?.lastCronFinishedAt || '',
    lastCronStoppedByRuntimeLimit: Boolean(automation?.lastCronStoppedByRuntimeLimit),
    lastCronError: String(automation?.lastCronError || '').trim(),
    ...overrides
  };
}

function normalizeScheduleCron(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseDailyUtcCron(scheduleCron) {
  const parts = normalizeScheduleCron(scheduleCron).split(' ');
  if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*' || parts[4] !== '*') return null;

  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return { hour, minute };
}

function latestDailyUtcCronOccurrenceMs(now, hour, minute) {
  const utcDayStartMs = Math.floor(Number(now) / DAY_MS) * DAY_MS;
  const todayMs = utcDayStartMs + hour * 60 * 60 * 1000 + minute * 60 * 1000;
  return todayMs <= now ? todayMs : todayMs - DAY_MS;
}

function nextJstExecutionBoundaryAfterMs(boundaryMs) {
  const sameDayBoundaries = scheduledExecutionTimes()
    .map((time) => todayJstExecutionBoundaryMs(boundaryMs, time))
    .sort((left, right) => left - right);
  return sameDayBoundaries.find((candidate) => candidate > boundaryMs) || sameDayBoundaries[0] + DAY_MS;
}

function timestampMs(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function floorNumber(value, min, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.round(number));
}
