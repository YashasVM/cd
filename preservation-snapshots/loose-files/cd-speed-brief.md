# CD transfer-speed effort: shared brief for every agent

CD (https://cd.yash0.in) moves files between devices. Parts:

- Browser app: Vite + vanilla JS in `src/` (`index.html`, `src/main.js`, `src/style.css`, design notes in `design.md`).
- Go CLI `cdx`: `cmd/cdx/`.
- Cloudflare Worker + Durable Objects relay: `worker/index.ts` (`TransferRoom` relays one transfer, `CodeDirectory` maps 5-digit share codes, `PeerSignal` is PeerJS signaling). Config in `wrangler.jsonc`.

Base commit for all work: `origin/main` @ 9732bbb. Integration branch `perf/transfer-speed` lives at `/home/yvm/code/cd-speed` (read-only for you unless told otherwise).

**Never touch `/home/yvm/code/cd`**: it is the user's main checkout with ~100 uncommitted files from unrelated work. You may *read* the audit docs there (see below), nothing else.

## How a transfer works on origin/main (verified by the coordinator)

- Protocol `cd-transfer-v1` (`src/agent-protocol.js`, `cmd/cdx/protocol.go`): AES-256-GCM records with a 12-byte header (`CD`, version 1, kind, 32-bit sequence, 32-bit length) + 16-byte tag; nonce derives from the per-direction sequence, so a sealer must never reuse a sequence. Record kinds: OFFER (JSON), ACCEPT, CHUNK (256 KiB plaintext; receivers accept only 64 KiB or 256 KiB `chunkSize`), ACK (12 bytes: chunk count + byte count, receiver sends every 1 MiB), END, COMPLETE, SIGNAL (WebRTC SDP/candidates). Max record 1 MiB.
- **Browser sender** (`src/relay-sender.js` `startRelaySend`, used by `src/main.js` `Sender` for every browser send, single file or zip bundle from `src/zip-bundle.js`): relay only. It never offers a direct WebRTC path, so browser→browser and browser→CLI always go through the Cloudflare relay. Fixed 8 MiB in-flight window; ACKs are only read when the window is full or at the end; reads, seals and sends one 256 KiB chunk at a time, serially.
- **Browser receiver** for codes/links (`src/share.js` `mountRelayReceiver`): joins the relay room; if the OFFER carries `direct.sdp` (only CLI senders do this) it answers via `src/direct-link.js` `answerDirect` and merges records from both paths in sequence order (`createRecordMerger`), dropping duplicates. Processing is serial: decrypt → `sink.write` (`src/sink.js`: OPFS / File System Access / memory tiers) → ACK every 1 MiB. Progress UI in `PANEL_HTML`/`renderProgress`.
- **CLI sender** (`cmd/cdx/sender.go`, `link.go`, `direct.go`, `window.go`, `stripe.go`): offers SDP in OFFER after waiting up to 1 s for ICE gathering; adaptive window 8–24 MiB (≈2×BDP); once the direct path opens it stripes data over relay + direct (`stripe.go`); pion SCTP receive buffer 8 MiB; data-channel pieces of 64 KiB.
- **CLI receiver** (`cmd/cdx/receive.go`): answers direct offers, ACKs every 1 MiB.
- **Relay** (`worker/index.ts` `TransferRoom.webSocketMessage`): forwards each binary frame to the other peer; closes both with 4429 if the peer's `bufferedAmount` would pass 32 MiB. Hibernatable WebSockets (`ctx.acceptWebSocket`).
- **Legacy browser P2P receive** (PeerJS): `src/main.js` `Receiver`, `src/raw-channel.js`, `src/relay-tunnel.js`, `src/p2p-*.js`.
- Progress/speed UI today: `src/main.js` `updateProgress` shows `bytes / elapsed-since-start` smoothed by EMA (a cumulative average, not a current speed). The share-page receiver panel (`src/share.js`) and `/send` page (`mountRelaySender`) show no speed at all.

Prior audit (describes the user's *unpublished* working tree, which differs from origin/main, e.g. `src/send-window.js` exists only there; use as hints, verify against your checkout): `/home/yvm/code/cd/docs/measurements/transfer-speed-plan-2026-10-18.md`, `...-transport.md`, `...-browser.md`, `...-evidence.md`.

## Ground rules

- Keep the security model: end-to-end encryption, no nonce/sequence reuse, duplicate/replay handling, authenticated records, bounded memory and queues, integrity checks.
- Keep compatibility: the released CLI (v0.3.5) and already-loaded web pages must still interoperate with new code in both directions, unless a change is explicitly negotiated (e.g. a new optional field the other side advertises).
- Match the surrounding code: comment density, naming, idiom. No new runtime dependencies without a strong reason.
- Commands: `npm test` (node --test src/*.test.js), `go test ./...`, `npx tsc` (worker types), `npm run build`. `scripts/harness.mjs` `startWorker(work)` runs a local relay (`wrangler dev`) on a free port; `scripts/bench.mjs` has CLI and browser benchmarks (Chromium via playwright-core, `findChromium()`).
- The machine is shared with ~8 other agents running builds and benchmarks at the same time. Absolute throughput numbers will be noisy: compare before/after with interleaved, paired runs (same script, alternate old/new) and report relative change plus raw samples.
- Do not deploy, push, open PRs, or change git config. Implementation agents commit on their own branch in their own worktree; review agents edit nothing.
- Final report (your last message): what you changed or found, with `file:line` references; measured numbers (method, before/after, samples); tests you ran and their results; compatibility and risk notes; anything unfinished.
