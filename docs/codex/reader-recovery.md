# Reader and Title Recovery

## 2026-11-19: Demeking

Target: `B00G26729S` / デメキング 完結版. Production had a URL fragment
(`https://m.media`) as its title and a last successful observation on November 14.
The last attempt included direct Amazon timeouts, no listasIn record and a
Kintyaku 403. Only this book had a URL-shaped title in the inspected store.

Three local implementation faults amplified remote access failures:

1. Reader URLs included two protocols (`http://https://...`).
2. A direct Amazon block disabled Reader even though Reader is a separate,
   already-configured fallback service.
3. The deep-discount guard deferred even an explicit Kindle checkout amount
   identified by matching source ASIN. This book was actually observed at
   660 yen / 7 points during read-only validation, not the stored 1294 yen.

The corrected request format follows the
[Reader documentation](https://github.com/jina-ai/reader#readme): prefix the full
original URL exactly once with `https://r.jina.ai/`. Respect opt-out settings,
host pacing, cancellation and the existing book/run deadlines. A working request
does not guarantee continued upstream availability.

## Safety Rules

- Only bypass the Reader deep-discount deferral when the source ASIN matches,
  the page identifies a Kindle edition, and an explicit JPY checkout amount has
  nearby Kindle purchase-terms evidence. Preserve the tiny/free-price guard and
  all subsequent snapshot validation. Reject a different source ASIN outright.
- Scope points to that purchase area rather than recommendation/navigation text.
  Carry explicit-price evidence when merging a metadata-only direct response.
- Treat whole URLs, image Markdown and transport/error headings as invalid titles.
  Never let them replace a valid stored title. Do not clean a CDN URL by stripping
  the `-amazon...` suffix and accidentally turn it into a plausible title fragment.
- Recover an invalid stored title only from history with matching ASIN, or a
  matching book ID when the legacy history record has no ASIN. Do not overwrite
  a valid title or borrow another edition's title based on book ID alone.
- A title-only repair must not refresh the price timestamp, invent a new price,
  delete history or send notifications. A fresh price repair must acquire and
  validate the actual current snapshot.
- Before directly repairing production data, wait until no price-check run is
  active, reread the latest store, and use the existing single-mutation bulk
  repair path. Do not cancel a healthy run or overwrite it with a stale snapshot.

Regression coverage exercises blocked-direct recovery, exact Reader URL format,
ASIN mismatch, preserved discount evidence, opt-out/tiny-price safeguards,
recommendation-point exclusion and identity-bound title restoration.
