# Modern Web Guidance Review

Reviewed on 2026-11-15 at commit
`4dd968349e54ca45a05dd5c818fb035c9054b022` of
[GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance/tree/4dd968349e54ca45a05dd5c818fb035c9054b022).

## Safety and Scope

This is development guidance for coding agents, not a browser UI library. The
reviewed package identifies GoogleChrome as publisher and Apache-2.0 as its license.
It also exposes a Node CLI. This review approves selective use of the published
guidance, not execution or a security certification of that CLI or future releases.

No installer, plugin, third-party browser script, runtime dependency, permission,
telemetry, or automatic update mechanism was added. Application data is not sent
to the guidance project. Existing Amazon cover requests remain unchanged in origin.
Some guides describe APIs with incomplete browser support; recommendations are
reference material, not instructions to execute verbatim.

## Applied

- Deferred creation of collapsed series' book cards until expansion. Collapse
  removes those cards again, while selected IDs remain in application state.
- Local disclosure updates retain the triggering button and its keyboard focus.
  Disclosure controls identify their panel and expose expanded state. Series and
  book selection controls have specific accessible names.
- Non-leading series covers use native lazy loading and asynchronous decoding.
  The leading group remains eager. Existing fixed cover dimensions are retained.
- Native dialogs retain `showModal()` and existing close/Escape behavior, with
  heading-based accessible names, viewport height limits and progressive scroll
  containment. `vh` remains a fallback for browsers without `dvh`.
- Keyboard focus outlines are visible on interactive controls.

No changes were made to storage, API contracts, price logic, notification delivery,
automation or database schemas. This is a browser rendering improvement, not a
reduction in the size of `/api/books` or in Blob transfer charges.

## Verification

- Regression tests cover deferred creation, expansion state, selection retention,
  safe title escaping, image loading attributes and dialog naming.
- Chrome/Playwright checks use an isolated local HTTP server with 3,000 synthetic
  books in 200 series; API writes are rejected and no production data is accessed.
  Desktop (1440 x 1000) and mobile (390 x 844) checks cover keyboard disclosure,
  focus retention, partial/full selection, sorting, dialog closing and horizontal
  overflow. Screenshots were visually inspected.
- In that fixture, initial DOM elements decreased from 96,924 to 4,124 and image
  elements from 3,200 to 200. These counts are not production Core Web Vitals or
  billing measurements; native lazy-load request counts vary by viewport/browser.

## References

- [Deferred rendering](https://github.com/GoogleChrome/modern-web-guidance/blob/4dd968349e54ca45a05dd5c818fb035c9054b022/skills/modern-web-guidance/guides/performance/defer-rendering-heavy-content.md)
- [Image loading priority](https://github.com/GoogleChrome/modern-web-guidance/blob/4dd968349e54ca45a05dd5c818fb035c9054b022/skills/modern-web-guidance/guides/performance/optimize-image-priority.md)
- [Native dialogs](https://developer.chrome.com/docs/modern-web-guidance/guides/ui-components/dialog)
- [Browser-level lazy loading](https://web.dev/articles/browser-level-image-lazy-loading)
