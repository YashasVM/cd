# Browser resume send pipeline

The sender permits four outstanding 256 KiB encrypted records. It retains only each record's cumulative byte count, chunk count and prefix digest. Each ordered, authenticated receiver ACK persists that specific prefix. Receiver write, flush and checkpoint-before-ACK behavior is unchanged.

Seven alternating order pairs measured 8 MiB with actual v2 HKDF, nonce proofs, AES-GCM records, sender hashing and checkpoint signing. The substituted network delays each ACK by 30 ms from receipt. It does not perform receiver storage writes, use a real network or establish browser throughput. The measured medians were 1246.4 ms before and 426.4 ms after, a 2.92x difference in this latency model. Raw rows are in `delayed-ack.json`.

`resume-browser-before.js.txt` preserves the exact original sender module. The runner rewrites its relative imports into the current repository, starts fresh Node processes, alternates pair order and records source hashes. Run serially from the repository root:

```sh
node docs/measurements/resume-pipeline-2026-10-26/bench.mjs /tmp/resume-paired.json
node --test src/resume-sender.test.js src/resume-browser.test.js src/resume-cancel.test.js src/resume-protocol.test.js
```

The focused tests cover exact received bytes, the four-record bound under withheld ACKs, MACed checkpoint prefixes while later records are in flight, interruption, invalid ACKs, source errors, cancellation, resumed offsets, empty files and short tails.

Live browser verification also exposed early removal of the OPFS file backing a download URL. The receiver now uses the existing `downloadUrlFor` cleanup callback and preserves the stage until URL revocation, matching the shared sink behavior. Download-backed results report retained bytes while that URL lives. The existing 60-second revocation timeout remains; page hide also revokes the URL.

## Actual browser to CLI transfers

Seven alternating order pairs used the built browser UI, actual local Worker v2 relay, and the same CLI receiver with its existing per-chunk durable checkpoint writes and final completion flush. Each random file was 8 MiB plus 77 bytes. All 14 received files passed SHA-256 verification outside the timed interval.

Receiver launch to durable process exit improved from a 541.0 ms median to 359.7 ms, a 1.50x difference. Sender completion improved from 548.6 ms to 365.6 ms. File selection to private-share readiness was unchanged at 290.9 ms versus 290.6 ms. Selection through durable receiver completion improved from 832.7 ms to 653.7 ms, a 1.27x difference. Receiver completion ranged from 501.6 to 586.8 ms before and 348.5 to 591.8 ms after. The candidate's final trial was an outlier, so the result has meaningful spread.

The baseline is the preserved original resumable sender served through Playwright route interception. Its source imports use the same current crypto, hashing and retention modules as the candidate build. Both module graphs load before file-selection timing. The candidate uses the built application bundle. A fresh browser context per transfer gives each run clean native sender storage. Output files use the host's temporary filesystem and the real CLI durability path. Shared host activity was not eliminated, and this local measurement does not predict mobile or internet throughput.

Raw rows, Chromium version, source and receiver hashes are in `browser-cli-paired.json`. Reproduce serially after building the application:

```sh
npm run build
node scripts/bench-browser-resume-paired.mjs /tmp/browser-cli-resume-paired.json
```

`CD_RESUME_PAIR_MIB` and `CD_RESUME_PAIR_RUNS` select payload size and trial count for exploration. The recorded evidence uses the defaults of 8 MiB and seven pairs.
