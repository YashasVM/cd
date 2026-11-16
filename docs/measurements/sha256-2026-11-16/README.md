# Incremental SHA-256 optimization, 2026-11-16

Baseline: `fb390760baaab971f9b9f92c2a5e5715adf69717`. Candidate replaces temporary arrays in the SHA-256 compression loop with scalar register assignments. SHA-256, wire protocols, checkpoint authentication, and storage durability behavior are unchanged.

Seven alternating trials per variant in headless Chromium hash the same fresh 16 MiB random input in 256 KiB chunks. Every digest matches Node's SHA-256. The isolated run measured median 355.2 ms before and 119.5 ms after (2.97x hashing throughput). The initial run measured 375.6 ms and 128.3 ms; some initial trials overlapped JavaScript tests, so use the isolated run for comparison. Raw trials, including slower rows, are retained in both JSON files. This is CPU hashing evidence on one host, not end-to-end transfer, phone, WAN, or world-leading speed evidence.

Reproduce from the repository root:

```sh
git show fb390760baaab971f9b9f92c2a5e5715adf69717:src/incremental-sha256.js > /tmp/cd-sha256-baseline.mjs
node scripts/bench-incremental-sha256.mjs /tmp/cd-sha256-baseline.mjs /tmp/cd-sha256-report.json
npm test
npm run typecheck
npm run build
CD_BROWSER_RESUME_ONLY=browser-browser node scripts/verify-browser-resume.mjs
CD_BROWSER_RESUME_ONLY=browser-browser-fallback node scripts/verify-browser-resume.mjs
```

Validation: 192 JavaScript tests passed, type checking and build passed. Added the million-a SHA-256 standard vector and independent cloned-prefix coverage. Both browser-only encrypted v2 transfers verified 8,388,685 bytes against Node SHA-256, using the OPFS Worker and fallback paths respectively. Each uses two contexts on one Chromium host and a local Wrangler Worker. These are correctness checks, not paired transfer-speed comparisons. CLI and interrupt/restart scenarios were not run: the installed `go` command is not the Go compiler.

The first browser check failed because it read removed `#share-private-link`; after fixing that, it failed because the expected completion text predated the download-status wording. Both failure logs remain here. The harness now reads the displayed private receive command, expects the current completion text, and skips unnecessary CLI compilation for explicitly browser-only scenarios. Assertions for full output digest/size and Worker write counts remain intact. The first failure used a scratch browser-only copy with CLI compilation removed; subsequent runs used the checked-in harness.

Next work: measure resumable transfer preparation and completion before/after on larger files; inspect storage/checkpoint cost without acknowledging uncommitted progress; validate direct/relay behavior across physical devices. The user's proposed faster transfer architecture has not been supplied. No deployment or merge was performed.
