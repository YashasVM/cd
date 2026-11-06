# Rejected browser bundle source read experiment

The candidate changed only `createZipBundle()`'s default file read size from 256 KiB to 4 MiB, matching the existing single-file source policy. Explicit caller overrides, streamed ZIP layout, CRC calculation, source validation and wire chunking stayed unchanged. The extra source buffer remained bounded to 4 MiB plus the existing rechunk buffer.

The measured browser UI sends two random files totaling 64 MiB plus 46 bytes. The actual CLI receives and unpacks the streamed ZIP. Receiver completion includes its extraction and the runner's file/directory sync. SHA-256 for both extracted files is checked outside timing. Each cohort uses seven alternating before/after pairs, reversing pair order each round, with fresh Chromium contexts and one shared local relay/CLI. The workerd compatibility flag disables WebSocket compression for both variants; WebRTC is disabled for this relay experiment.

The first cohort's durable completion median improved from 1370.2 ms to 1194.4 ms, or 1.147x. Repeating the full experiment with fresh runtime/browser state measured 1130.6 ms before and 1138.9 ms after, or 0.993x. Total completion likewise changed from 1201.0 ms to 1204.2 ms in the repeat. The initial gain did not reproduce, so the production change and its candidate-only test were removed. All 28 measured transfers passed both extracted file hashes.

The candidate test also passed exact ZIP byte comparison against small explicit reads, and the existing ZIP/unzip, receive-bundle and encrypted relay tests passed. That establishes correctness, not a reason to retain a change without a repeatable speed improvement.

`paired.json` and `paired-repeat.json` retain every accepted timing row. The repeat also records full frozen frontend asset hashes. Exact before/candidate source snapshots and the runner remain available even though production reverted. The runner builds isolated Vite outputs by substituting only the frozen ZIP source, leaving the workspace's `dist` unchanged. Run serially from the repository root:

```sh
node scripts/bench-browser-bundle-paired.mjs /tmp/bundle-paired.json
```

`CD_BUNDLE_PAIR_RUNS` and `CD_BUNDLE_PAIR_MIB` select exploratory workload sizes. The recorded cohorts use the defaults of seven pairs and 64 MiB. Source readiness is timed separately from receiver launch through durable extraction completion. A granted local-network-access permission lets Chromium use loopback WebSockets when Playwright fulfills the frozen navigation HTML.

These are local Chromium and temporary-filesystem measurements. Shared desktop activity was not eliminated. They do not establish internet or phone performance.
