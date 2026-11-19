# Fallback Acquisition

## Verified Audit: 2026-11-19

The audit covered the individual-book and series-discovery acquisition paths,
their HTTP pacing/retry queues, snapshot validation, and persisted price evidence.
Production data was not bulk-rewritten and notifications were not replayed.

| Path | Order / Scope | Protection |
| --- | --- | --- |
| Keepa | Only configured `keepa`/`auto` modes with a key | Child deadline, HTTP deadline, parent cancellation, ASIN and JP domain checks |
| Direct Amazon | Existing product/search candidates | Existing direct-phase budget, page-level ASIN/canonical checks |
| listasIn | Before Reader by default; existing late-fallback setting retained | Child deadline includes retry waits, record-key/reported-ASIN checks, JPY/numeric validation |
| Amazon Reader | After early listasIn, before Kintyaku | Child deadline, requested-source identity, recommendation-section exclusion, purchase evidence |
| Kintyaku | After Reader | Child deadline includes multi-query/page work, exact ASIN lookup, explicit currency/points validation |
| Series supplements | Gamepedia, Sale-bon, Kintyaku, efox, Kinpome | Existing series caller deadline and HTTP timeouts now propagate through every supplemental call and catch |

`FALLBACK_PROVIDER_MAX_RUNTIME_MS=12000` is a separate child allowance for each
individual price provider, not extra time beyond the existing book/run budget.
A child timeout permits the next provider; parent cancellation stops subsequent
requests. Existing provider opt-outs, order, host delays, blocking cooldowns and
save reserves remain in force. A usable metadata-only Keepa response must not
stop `auto` mode from looking for a price. Explicit `keepa` mode remains exclusive.
Series imports/discovery keep their existing caller budgets and page limits;
the 12-second per-price-provider cap is not a new truncation limit on imports.

Verified local defects included missing series cancellation propagation, an
unbounded raw Keepa request, retry/query multiplication within a provider, and
waiting behind a throttled request even after cancellation. Queue cancellation
must return promptly, observe the eventual queued rejection and not consume a
new network slot. Do not disable host throttling or add book-skipping circuit
breakers to work around these defects.

## Price Integrity

- Reject an explicitly different product identity or foreign currency, negative
  or nonfinite price/points, and points above the price. Missing legacy optional
  identity/currency fields do not themselves invalidate an exact-ASIN record.
- Check direct page identity only in main `ASIN` inputs/canonical links, not in
  unrelated recommendation-card identifiers. Reader series identity refers to
  the actual requested URL, which may be a sibling seed rather than the series
  collection ASIN. An absent Reader source remains unverified, not verified by
  assumption.
- Preserve Reader's conservative deep-discount deferral unless both explicit
  Kindle checkout evidence and source identity were verified. Keep its tiny-price
  guard. Related-item headings terminate the individual product price/points
  search; they are not another source of a main-product offer.
- Keep price, points, effective price, provider and evidence together when merging
  a metadata-only response. Carry evidence into book records, history, deduplication,
  restoration and reload validation. Clear it for replacement prices without that
  evidence. A successful parser test alone does not prove the checker will save
  the price: a second conservative guard previously rejected verified Reader
  discounts and could remove them again during store repair.
- Do not change notification thresholds, refresh failed-book success timestamps,
  bypass oldest-first scheduling, or write a stale production store as part of
  an acquisition-path refactor.

## Regression Coverage

`test/fallback-pipeline.test.mjs` uses mocked HTTP and an isolated temporary store.
It covers provider ordering/opt-outs, child deadline recovery, parent cancellation,
Keepa metadata fallthrough, source/ASIN/currency/numeric rejection, recommendation
exclusion, all supplemental series providers, cancellation behind host pacing,
listener cleanup, history restoration, and a full save/reload/repair cycle. It
also checks stale evidence is cleared by a later direct observation while the
earlier valid history, settings and sent notifications remain intact.

Remote blocking, throttling, incomplete third-party catalogs and delayed external
prices remain possible. These tests establish local control-flow/data-integrity
behavior, not availability or real-time freshness of every service. Do not claim
fixed whole-run speedups or enable a currently unused paid provider on this basis.
