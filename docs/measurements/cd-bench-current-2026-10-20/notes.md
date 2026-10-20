# CD and croc comparison

The question is which CLI completes the same transfer sooner, and why the answer differs by payload and path.

This report measures the existing checkout without changing transfer code. The checkout already contains uncommitted TCP and chunk-size improvements. A private built executable freezes the tested implementation. Installed tools are left intact.

Data objects: one row per transfer, with tool, payload bytes, storage, allowed route, observed route, trial index, readiness, native receiver completion, completion with file and directory flush, total completion, SHA-256, and failure details.

Scenarios: local relays on the same PC; physical PC to Ubuntu LAN; diagnostic WebRTC with TCP disabled. Warm input cache. Independent serial suites. Rotate tool order. Treat incompressible random bytes and repeated-byte payloads separately.

Presentation: filterable benchmark report. Achromatic ledger, seed 123028957. Blue-grey ground and CD's measured series in blue give the report its face. The unique element is the actual route under each CD result. No stock imagery or invented data.

Evidence limits: local-relay results are not hosted-service internet throughput. Numeric CD code and croc PAKE are not a security-equivalence comparison. Physical LAN timing includes SSH receiver launch. Three or seven repetitions do not establish universal speed. SHA-256 is checked outside timing; file and directory flush are included for both tools.

## Experiments

- Installed croc is 10.7.0; final reference is the upstream 11.5.5 release. The staged archive matched its upstream checksums file. Neither installed executable was replaced.
- Initial rapid 11.5.5 trials exhausted relay admission limits. Those runs are retained as admission-limited diagnostics and excluded from winning claims. The private benchmark relay raises both source and room admission limits, and secrets start with random bytes. Production relay settings are untouched.
- Browser baseline completed 18/18 verified 64 MiB transfers.
- 768 KiB negotiation needs a browser minimum send window of at least two chunks, because ACKs occur at 1 MiB. A regression test covers large chunks through the actual encrypted browser send engine. Legacy 64/256 KiB peers retain their negotiated limits.
- Native File.stream did not produce a consistent end-to-end gain and was reverted.
- A synchronous OPFS worker removed the measured asynchronous storage writes but did not reduce total completion enough to justify the new lifecycle. The prototype was removed.
- The storage probe measured 86 writes and 773–1138 ms in the 768 KiB experiment. Batching into approximately 4 MiB reduces this to 15 writes and 225–233 ms in a 64 MiB smoke transfer. The final multi-trial end-to-end comparison remains the acceptance evidence.
- Automatic direct discovery can finish successfully over relay before ICE opens. The performance runner now records that actual route instead of misclassifying a verified automatic fallback as data-transfer failure. The strict transport verification runner continues to require real direct payload.


## Isolated acceptance run and transport diagnostics

The serial acceptance run used committed snapshot 046d8e5 and the frozen CD binary with SHA-256 `90cc18ddf508874f3cf3a6ad59a937617f7ceaf7228b11341ce9cb0999a09768`. The competing performance goal was stopped before this run. All 420 native, 42 browser, 9 physical-LAN and 18 TCP-disabled diagnostic trials passed payload verification. `isolated-gates.json` recomputes the acceptance medians from raw verified rows. Its evidence is complete, but no required scenario passes every timing gate. Browser CD is explicitly compared with native croc at the same payload size, storage and route setting.

Raw 64 MiB browser-to-Node WebSocket transfer through the actual local Worker takes about 1.6–2.0 seconds without CD encryption, disk writes or application acknowledgements. The stateless local Worker echo diagnostic at 16 MiB also favors WebSocket, about 406–429 ms, over bounded HTTP echo, about 514–555 ms. HTTP buffers the upload before responding while WebSocket echoes during upload, so this does not isolate protocol overhead. The streaming HTTP echo timed out on the local runtime; no speed claim is made for it. Diagnostic Worker configurations have no public routes and are never deployed.

An event-driven WebRTC drain candidate replaced 10 ms polling. Seven trials in each direct-allowed browser direction verified all bytes. Median receiver-plus-flush times changed from 3457.9 to 3834.1 ms for browser-to-browser, 1126.0 to 1260.9 ms for browser-to-CLI, and 1538.0 to 1383.2 ms for CLI-to-browser. This before/after experiment does not show a consistent improvement, so the production change was removed. Raw results remain in `drain-events-browser.json`. No 1.5× achievement is claimed.


## WebSocket compression

Handshake evidence exposed a large cost hidden inside the original raw browser measurements. Setting the compatibility flag on a Worker behind Wrangler's development proxy did not disable compression on the client-facing connection. Explicit empty extension headers at the Durable Object and outer Worker also left the measured handshake compressed. Those attempts are not evidence of compression being disabled.

A direct workerd runtime with `no_web_socket_compression` negotiated an empty extension string and verified 64 MiB raw transfers in 306.9–326.0 ms, compared with about 1.5 seconds with compression. A separate loopback proxy that removed the extension offer also verified the same transport improvement. Switching the preserved relay prototype between standard and hibernating WebSockets did not produce a comparable gain.

The complete encrypted comparison uses the committed 046d8e5 Worker and frontend, the same frozen CLI binary as the acceptance run, and seven repeats per browser path. The two sequential suites differ in the runtime compatibility flag. Payloads have the same size and random entropy class but different hashes across suites. The frontend loads from the same local static server before transfer timing. Its byte-preserving WebSocket proxy keeps extension negotiation intact. The runner asserts the negotiated extension for every browser relay socket.

All 84 encrypted trials verified their payloads. Receiver-plus-flush medians with compression on/off were 2250.3/1212.7 ms for browser-to-browser relay, 1979.9/769.8 ms for browser-to-CLI relay and 1492.9/979.9 ms for CLI-to-browser relay. These are 1.86×, 2.57× and 1.52× improvements over CD's previous setting. Direct-allowed medians were 3493.3/3564.9, 1415.3/1372.4 and 1443.6/972.6 ms respectively. WebRTC carries records directly after upgrade, so relay compression is not a uniform direct-path speed fix.

The PR disables WebSocket compression in wrangler.jsonc. Ciphertext framing, encryption, authentication and legacy record negotiation stay unchanged. Production CD has not been deployed. Miniflare is pinned as a direct development dependency because the new benchmark runtime imports its API. Reproduce from a clean Prof checkout with `bash scripts/bench-browser-compression.sh`. The main acceptance charts remain the earlier full croc run; the compression iteration is separate, and the 1.5×-over-croc target remains unmet.


Validation for this increment: 113 unit tests passed; type checking passed; Wrangler generated types record the new flag; the isolated test-environment dry-run packaged successfully. All ten 64 MiB transport cases passed with compression disabled, including mixed browser/CLI directions, forced relay, slow decrypt and relay-to-WebRTC upgrade. The verification artifact records empty extension strings for every browser relay socket. See [Cloudflare's compatibility flag documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#websocket-compression) for the runtime setting.
