# Matching croc browser comparison and source-copy iteration

The original target was at least 1.5× faster than the faster croc reference on every required speed metric and scenario, preferably 2×, with smaller runtime code. Android is excluded. No acceptance gate was removed. The original native-croc cross-interface comparisons remain in the report, alongside the new matching-browser comparison.

## Matching browser baseline

Croc 11.5.5 has an official browser client. Its tagged `web/README.md` documents sends and receives through an opaque WebSocket-to-TCP bridge. The prior report's browser table compared CD with native croc, not croc's browser. It was explicitly labeled as a cross-interface reference, but it did not answer which browser client was faster. The report now includes both comparisons.

The upstream source is tag `v11.5.5`, commit `8a806c36956533f9c003c55f16e31fcf14133f8e`. The checkout was clean. `npm ci` and `npm run embed` built its documented browser/WASM client. Its build script requires Go 1.27.1, which Go downloaded into the toolchain cache. `go build -trimpath -ldflags='-s -w' -o /tmp/croc-browser-bench-web ./cmd/croc-web` built the separate embedded server. The CLI is the previously checksum-verified official croc 11.5.5 release. Source, browser-server and CLI identities are recorded in the raw report.

The comparison uses CD frontend snapshot `974c6cd` in `/tmp/cd-ponytail-browser-before`, the retained frozen CD CLI, and the frozen local Worker bundle. Both tools use Chromium 154.0.8037.97. Each round runs CD then croc, reversing the order on alternate rounds. Each tool has its own private loopback relay. Source and output are RAM-backed, with warm input. Each suite creates new browser contexts and preloads the pages before timing. Synthetic random inputs have the same size and entropy class but different hashes across suites. Server startup and browser build time are excluded.

All 63 transfers verified SHA-256: 42 CD transfers across six direction/mode combinations, plus 21 croc browser transfers across its three supported direction combinations. Croc browser uses relay transport; its per-direction reference is reused beside CD direct-allowed and forced-relay modes. This is explicit in the page and raw method. No competing benchmark process was observed. Other desktop activity was not eliminated. These are same-host results, not public-internet or physical-LAN claims.

CD receiver-plus-flush is 2.15× to 4.45× faster in five combinations. Browser-to-browser direct-allowed completion is only 1.20× faster. Three combinations meet all four timing gates; CLI-to-browser still misses readiness. The new matching-browser gate is complete but not achieved. The original universal target remains unmet, including the native reference gates and the 100 Mb/s physical link constraint. The user narrowed the final scope to practical terminal/browser software improvements on current hardware and requested a prompt wrap-up; this run closes with the verified improvements and published evidence, without claiming universal success.

Readiness semantics differ. Croc prints its generated CLI code before `setupLocalRelay` and `connectRelayControl` in `Client.Send`. CD shows a numeric code after relay registration. Both native events remain timed. The code-display guarantee was not weakened to improve the score.

## Retained source-copy change

For a single file, browser sends now use bounded subarray views from the existing 4 MiB source reads. The engine already slices each source block into transport records, so the intermediate `rechunk` pass copied the data unnecessarily. Bundles retain their prior batching. Negotiated wire limits, encryption, acknowledgments, cumulative byte checks, legacy peers and bounded memory remain intact.

Three alternating seven-round comparisons verified all 42 outputs. Browser-to-CLI relay medians changed from 618.5 to 576.3 ms, about 6.8% less time. Browser-to-browser direct-allowed changed from 3681.3 to 3512.8 ms, about 4.6% less time. Browser-to-browser relay changed from 1041.9 to 1056.5 ms, about 1.4% more time. The report shows every result and claims no uniform improvement.

The runtime change adds 34 bytes on one existing line. Combined with the preceding Go simplification, affected runtime code is still six lines and 54 bytes smaller than at the start of this goal. Tests and benchmark artifacts are excluded from that count. `code-size.json` records the calculation.

All 117 JavaScript tests pass, including missing/duplicate/failed-trial gate regressions and exact encrypted bundle bytes. The frontend build passes. All ten real 64 MiB transport cases pass from the candidate checkout, including browser/CLI directions, slow receivers, relay fallback and actual relay-to-WebRTC upgrades.

## Reproduce

Build the tagged upstream browser as described above. Keep its source and binaries in the recorded `/tmp` locations, or supply `CD_CROC_SOURCE_DIR`, `CD_CROC_WEB_BIN` and `CD_BENCH_CROC`. Build the intended CD snapshot separately and provide `CD_CROC_CD_ROOT`, `CD_BROWSER_CDX` and `CD_BENCH_RUNTIME_BUNDLE`.

```sh
CD_CROC_BROWSER_MIB=1 node scripts/bench-croc-browser.mjs
CD_BENCH_RUNTIME_BUNDLE=/path/to/frozen-worker/index.js CD_BENCH_NO_COMPRESSION=1 CD_BROWSER_CDX=/path/to/frozen-cdx CD_CROC_PAIRED_OUTPUT=/tmp/matching-browser.json node scripts/bench-browser-croc-paired.mjs
node --test scripts/bench-browser-croc-gates.test.mjs
node docs/measurements/ponytail-browser-2026-10-20/build-report.mjs
node docs/measurements/cd-bench-current-2026-10-20/build-report.mjs
node scripts/verify-bench-report.mjs
```

The report builder reads the checked-in paired data and independently recomputes gates, medians and spread. Its source-copy section also requires successful transport verification. The live checker recomputes all 24 matching-browser chart cells from raw trials, in addition to the earlier report checks. Only the benchmark report is deployed; production CD is not deployed.

Primary sources: [tagged upstream browser documentation](https://github.com/schollz/croc/blob/v11.5.5/web/README.md), [tagged upstream browser tests](https://github.com/schollz/croc/blob/v11.5.5/web/e2e/transfers.spec.ts), [CLI readiness implementation](https://github.com/schollz/croc/blob/v11.5.5/src/croc/croc.go#L1785).
