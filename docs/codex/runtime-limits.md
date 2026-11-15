# Runtime Limits

## Verified Incident: 2026-11-15

Recent GitHub Actions runs completed successfully as jobs, but the application
saved partial results near its five-hour limit. Dependency setup took seconds;
the price-check step consumed the time. This was not an Actions runner timeout.

| Run | Checked / Planned | Failed | Timeout Errors |
| --- | --- | --- | --- |
| [43580231097](https://github.com/hiyokko/kindle-price-watch/actions/runs/43580231097) | 440 / 1100 | 192 | 191 |
| [43516738561](https://github.com/hiyokko/kindle-price-watch/actions/runs/43516738561) | 283 / 1100 | 151 | 151 |
| [43296071321](https://github.com/hiyokko/kindle-price-watch/actions/runs/43296071321) | 415 / 1100 | 86 | 86 |
| [43118541290](https://github.com/hiyokko/kindle-price-watch/actions/runs/43118541290) | 926 / 1100 | 114 | 111 |

Logs repeatedly combined an aborted direct Amazon attempt with timeout errors
from every subsequent provider. A deterministic mocked-network reproduction
confirmed a local failure mechanism: the preliminary series lookup could exhaust
the entire 60-second book cancellation budget. The individual fallback then
received an already-aborted signal, even when its simulated endpoint was healthy.
Rejected series lookups were deleted from the cache, repeating that work for the
next volume. Price-only lookups also performed unrelated completion probes.

Historical logs did not record phase durations. The reproduction establishes a
real amplification bug, not the original remote reason for every slow response.
Do not claim all providers were independently unavailable or that a particular
hosting network caused all timeouts from these combined error messages alone.

## Fix and Invariants

- `SERIES_PRICE_LOOKUP_MAX_RUNTIME_MS=15000` gives price-only series acquisition a
  separate child deadline, capped at one quarter of the per-book allowance even
  if that allowance is reduced later. With the existing 60-second book cap, it leaves time
  for individual retrieval. Cancelling a child phase must not cancel its parent;
  parent cancellation must still propagate to the child.
- `SERIES_PRICE_FAILURE_RETRY_MS=300000` suppresses repeated failed price-only
  series lookups in the run-local cache for five minutes. Individual book checks
  continue. Expiry permits recovery; a new run starts with a new cache.
- Price-only cache keys are separate from full discovery keys. Full discovery
  results may satisfy pricing, but price-only results must not suppress discovery
  or completion probes. Negative pricing entries never block full discovery.
- Completion, new-volume discovery, suspicious-price validation, oldest-first
  scheduling, notification rules and conflict-safe bulk persistence are retained.
- Cancellation must stop HTTP retries and retry sleeps promptly. The standalone
  listasIn provider must receive the same cancellation options as other providers.
- Do not raise global runtime limits or remove rate-limit protections to hide
  slow preliminary lookups. Retain save reserves and leave healthy active jobs
  running on their original checkout.

## Diagnostics and Verification

Completed run results/logs now include `timings` for setup, import/audit, initial
series discovery, book checking, cached retries, list-price supplementation,
price audit, notifications and persistence. `priceAcquisition` reports aggregate
series/individual lookup time, price hits and negative-cache skips. These are
run diagnostics, not new database fields. Hit counts precede price validation;
they are not successful-save counts. `bookChecksMs` also includes pacing and
per-checked-book discovery, so nested timings must not be summed twice.

Regression coverage includes the pre-fix failure reproduction, fallback recovery,
cache expiry and recovery, separate completion/discovery cache semantics,
cancellation/listener cleanup, and a full isolated check with settings and sent
notifications preserved. Tests never use production storage or real price sites.

GitHub/production code can be updated while a price run is active; that run keeps
its checked-out code. Measure actual whole-run improvement on a subsequent run
using the new diagnostics. Do not promise a fixed duration or full batch coverage
from synthetic tests, especially while remote latency remains variable.

## Oldest-First Recovery

A later check of run `43639227285` found that it still used commit `01b562a`,
before the acquisition-time fix. It attempted all 960 selected overdue books but
only 644 succeeded. Do not mistake attempted counts for successfully refreshed
prices, or attribute an older checkout's results to a new deployment.

- The protected oldest-first prefix now starts at 24 hours instead of 48, in
  both the planner default and Actions configuration. Age takes priority over
  discount scores, series completion and fresh additions.
- Keep `lastCheckedAt` at the previous successful observation on nonterminal
  acquisition failure. Record `lastCheckAttemptedAt` and `lastCheckAttemptError`
  separately; use attempt time for retry cooldown. Historical records without
  these optional fields remain supported. Permanent non-book exclusions retain
  their terminal-handling behavior. Do not bulk-rewrite historical timestamps.
- Per-checked-book discovery waits until the selected overdue prefix has been
  attempted, instead of interleaving expensive exploration between those checks.
  Existing initial discovery and new-release follow-up logic remain available.
- Before proceeding to fresher checks, give transient overdue failures one
  bounded individual-price retry (or use a validated series cache if available).
  Defaults: `CHECK_OVERDUE_RETRY_LIMIT=10`,
  `CHECK_OVERDUE_RETRY_MAX_RUNTIME_MS=300000`,
  `CHECK_OVERDUE_RETRY_BOOK_MAX_RUNTIME_MS=30000`. These remain inside the existing
  global runtime and save reserve, not an extension of them. Stop extra retries
  on blocking responses, and never immediately retry known blocked/permanent
  failures. Other old books receive their first attempt before any extra retry.
- Log `overdueRetries` separately; retries replace the original result rather
  than incrementing the unique checked-book count. The check-plan summary reports
  overdue successes, failures and remaining age-based backlog. Nested timing for
  overdue retries is included in `bookChecksMs`, not additional elapsed time.

Regression tests use isolated stores and mocked HTTP to verify old-before-fresh
retry ordering, discovery deferral, preserved failed-book age, attempt-based
cooldown, bounded retries and unchanged settings/sent notifications. A failed
check must stay visibly old; do not hide a backlog by advancing its timestamp.
