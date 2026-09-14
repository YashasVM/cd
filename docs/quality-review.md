# CD quality review

The review compared default branch `master` at `f712444` with `agent` at
`8967627`, then checked the shared browser, relay, CLI, and Android code.
The user requested reliable transfers, a polished interface matching yash0.in,
better performance, and publication on `main` and `cd.yash0.in`.

## Standards

The fixes address these concrete code-quality findings:

- Signaling parsed JSON into an asserted object type. JSON `null` left a
  connection hanging. The Worker now validates the value before reading fields.
- Slow signaling peers had no output buffer limit. The Worker now closes a
  peer whose pending output exceeds the existing memory budget.
- Failed OPFS setup leaked temporary entries. Staging names included user
  filenames, which could exceed filesystem limits. Setup now cleans up failures
  and uses a UUID independently of the download name.
- Download cleanup could run twice or leave a rejected promise unhandled.
  Revocation is now idempotent and handles asynchronous cleanup failures.
- Receive operations could finish after cancellation and mutate another
  transfer's sinks, counters, or progress. Awaited operations now check their
  transfer generation and release stale resources.
- Service-worker writes were not tracked and cached error responses. Cache
  work now has an event lifetime, and only successful responses enter the cache.

These are behavior and lifecycle defects, not cosmetic refactoring requests.
The review did not identify a conflicting documented coding standard.

## Spec

The improvements address these user-visible gaps:

- OPFS failure bypassed Safari's memory limit. Both receivers now apply the
  same fallback policy and refuse oversized memory downloads on WebKit.
- Clicking the active tab reset a transfer unnecessarily. Active-tab clicks
  now preserve the session, and the tabs support keyboard navigation.
- Styles arrived through dynamic JavaScript. The HTML now loads the stylesheet
  directly, while repeat visits use cached immutable app assets.
- Low-contrast labels, narrow scanner layout, small cancel controls, and broken
  share-code wrapping made the interface harder to use on phones. These styles
  now use the existing yash0.in palette with more readable controls.
- The configured domain was already `cd.yash0.in`. Canonical metadata and the
  footer now consistently identify CD and link to yash0.in.
- Release checks omitted browser transfers. CI and release verification now
  include them, with hosted checks available for both transfer paths.

## Verification

The executable checks include unit tests, TypeScript checks, Go tests and vet,
dependency vulnerability scans, an Android debug build and lint, and a Worker
deployment dry run. Browser checks compare downloaded bytes with generated
source files through the CLI relay and browser-to-browser transfer paths.

The browser matrix covers OPFS, memory fallback, and advertised-but-unavailable
OPFS. Playwright checks also cover phone and desktop layout, keyboard tabs,
invalid-code feedback, and absence of horizontal overflow.

This review does not establish a maximum transfer speed or unlimited file size.
Available disk space, browser limits, and peer network connectivity still bound
transfers. Real-device Safari and Android transfer QA remains separate from
Chromium automation and Android compilation.
