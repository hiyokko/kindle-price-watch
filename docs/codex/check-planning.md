# Check Planning and Compatibility

- Long-unchecked books must reserve the first check slots before discount, series-completion, or new-release priorities. Sort that prefix by check age; do not rely on an age bonus that stops increasing after a fixed day count.
- Missing or invalid check timestamps use registration time, then update time, as a stable fallback. Retain retry cooldowns and the existing batch/runtime/save limits.
- Dynamic new-release insertion must preserve the unprocessed overdue prefix, and must not evict it to make room for a fresher addition.
- Keep the planner pure and independent of network access, notifications, and persistence. Production plan verification must not call a price-check or repair endpoint.
- Keep healthy price-check runs serial across delayed schedule and watchdog events. A new event or source SHA is not a reason to cancel an in-flight run.
- Preserve the store schema, notification event definitions, notification thresholds, and final synchronous conflict-retryable bulk mutation when refactoring orchestration.
- Validate refactoring with notification-event and public-payload comparisons, concurrent metadata/addition/history/queue preservation tests, and read-only production plan replay. Include an oldest-first regression where fresh priority candidates continue to arrive across multiple batches.
