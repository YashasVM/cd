# CD versus Immich upload benchmarks

Stock Immich wins every measured LAN case and the two smaller public-path cases. CD followed by a localhost Immich upload wins the 48 MiB public-path case, taking 13.59 seconds versus 18.02 seconds. That is 24.6% less time, or 1.33 times the effective throughput. These measurements support exploring CD for larger uploads over a constrained public route. They do not support replacing all Immich uploads with CD.

Measured 2026-10-26 from this PC over Wi-Fi to the Linux box. Stock Immich v3.3.5 runs in an isolated Docker project. CD is built from the current working tree. Each cell is a median of three trials. All 36 final samples passed independent original-file SHA-256 verification.

| Path | Payload | Immich | CD to disk | CD + Immich import | Bridge score |
|---|---:|---:|---:|---:|---:|
| LAN | 0.75 MiB | 0.23 s | 6.14 s | 6.75 s | 3.4 |
| LAN | 12.01 MiB | 1.16 s | 7.03 s | 7.71 s | 15.1 |
| LAN | 48.02 MiB | 4.42 s | 11.88 s | 13.10 s | 33.8 |
| Public services | 0.75 MiB | 0.97 s | 4.73 s | 5.12 s | 19.0 |
| Public services | 12.01 MiB | 5.45 s | 5.66 s | 6.35 s | 85.9 |
| Public services | 48.02 MiB | 18.02 s | 12.44 s | 13.59 s | 132.7 |

Immich scores 100 in each row. Bridge scores measure relative throughput, so higher is better. CD to disk excludes asset registration; CD plus Immich import is the practical integration result.

At 48 MiB, LAN throughput including startup is 10.85 MiB/s for Immich and 4.04 MiB/s for CD to disk. Public-path throughput is 2.66 MiB/s for Immich and 3.86 MiB/s for CD to disk. Including local import, CD delivers 3.53 MiB/s on that public-path case.

CD used relay delivery for the two smaller LAN sizes. Its 48 MiB LAN transfers mixed relay and WebRTC. Public-path CD explicitly uses relay fallback. Share setup costs about 1–2 seconds before receiver launch; peer negotiation and transfer add more. A persistent or bundled integration could amortize setup costs, but that behavior was not tested.

## What the internet result means

Immich ran through a temporary Cloudflare Tunnel and CD through its hosted relay. The endpoints were still on the same home network. This measures public service routing, not a remote phone, cellular upload or another ISP. Different proxy routes and server locations contribute to the difference. The test does not isolate a protocol-level advantage for CD.

## Integration recommendation

Keep native Immich uploads for LAN and small photos based on these measurements. A larger-upload CD option is worth a prototype only if it preserves Immich authentication, quotas, duplicate handling and asset registration. The measured bridge calls the existing upload API after receipt. It is not a production integration or a mobile app patch.

Immich can also scan a directory received through CD as an [external library](https://docs.immich.app/features/libraries/). That changes the library workflow and was not benchmarked. Simply writing files into Immich's managed upload directory does not register them as assets. The normal [upload API](https://docs.immich.app/guides/python-file-upload/) remains the supported route tested here.

## Evidence

- [Full method and limitations](method.md)
- [Raw final samples](results.json)
- [Computed scores and transport reports](summary.json)
- [Hardware and source provenance](provenance.json)
- [Benchmark runner](bench.py) and [score calculation](summarize.py)
- `pilot-results.json` and `failed-public-results.json` contain discarded harness and tunnel-routing failures. They contribute no scores.

No gallery-batch, persistent-session, mobile, cellular, HEIC, video-transcoding or power-loss durability tests were performed. Timings stop at file receipt or Immich upload acceptance and do not include completion of thumbnails, indexing or machine learning.

## Direct TCP diagnostic

Three additional 48 MiB trials using the existing physical-LAN harness, local rendezvous and WebRTC disabled all failed the required TCP telemetry gate. They completed through relay and are not counted as direct-TCP scores. A separate 12 MiB debug trial also used relay and logged `no offered address shares a local network` during peer selection. This identifies a routing-selection obstacle; its root cause was not diagnosed or fixed. It would be premature to conclude that CD's best direct TCP transport is slower than Immich from these results.

See `direct-lan.json` and `lan-debug.json`. These use random binary payloads and different rendezvous from the main PNG tests, so their durations are not substituted into the main table. `direct-lan.mjs` reuses the existing LAN harness with CD-only trials. Its inherited croc comparison fields have no comparative meaning.

The temporary test containers and public tunnel were stopped after measurement. Synthetic test data remains under `~/immich-cd-bench-20261026` on the Linux box for review. Existing Immich stacks remain in their original stopped state.
