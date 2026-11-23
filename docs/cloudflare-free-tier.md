# Cloudflare free-tier deployment and capacity

Checked against Cloudflare's documentation on 2026-11-16. CD's hosted core
uses Worker Static Assets, one Worker, and SQLite-backed Durable Objects.
There is no payload bucket or separately hosted relay. CLI processes and
browser tabs run on the endpoints. A free deployment is possible **within
the account's quotas**; an unlimited free relay or guaranteed global transfer
speed is not a property of this architecture.

## Capacity to monitor

| Resource | Free allowance |
| --- | --- |
| Worker invocations | 100,000/day; 10 ms CPU per HTTP invocation |
| Durable Object request units | 100,000/day |
| Durable Object active duration | 13,000 GB-s/day |
| Durable Object SQLite reads | 5 million rows/day |
| Durable Object SQLite writes | 100,000 rows/day |
| Durable Object SQLite storage | 5 GB/account |

Worker and Durable Object allowances are separate. Incoming DO WebSocket
messages use a 20:1 request-billing ratio; connection setup, RPC sessions and
alarms also consume requests. Outgoing messages do not. SQLite KV methods
also count as row operations; alarm updates and deletions count as writes.
Free-plan quota exhaustion rejects further operations until reset at
00:00 UTC. See [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

Static asset requests are free and unlimited when they bypass Worker code.
CD's `run_worker_first` paths, including `/`, invoke the Worker even when it
ultimately serves an asset. Such paths use the Worker request allowance and
can stop working when it is exhausted. See [asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

## What P2P saves

An exclusively direct data path keeps its file records off the
relay. Negotiation, code lookup, connection setup and any remaining relay
control records still use hosted resources. Measure `directBytes` and
`relayBytes`; merely seeing an ICE connection is insufficient evidence.
In particular, CLI striping is enabled by default and also carries file records
through the relay after a direct connection opens. Set `CD_STRIPE=0` for
exclusive direct data after the upgrade; initial records still use the relay.
Benchmark these configurations separately
and include those relay records in the quota budget.

For illustration, a fully relayed 1 GiB payload at 256 KiB/chunk needs at
least 4,096 incoming data records, approximately 204.8 DO request units
before ACKs, setup, code-directory RPCs or alarms. Two million incoming
messages would consume the entire 100,000-unit daily DO allowance before
other operations. These are arithmetic estimates, not a guaranteed daily
byte allowance: chunks vary by path, ACK frequency varies, and active
duration or storage operations may exhaust first.

At 128 MiB allocation, 13,000 GB-s corresponds to approximately 104,000
active object-seconds, shared across the account; hibernation reduces idle
cost. One object per transfer distributes work, but every individual object
is single-threaded and has a documented soft limit around 1,000 requests/s.
Neither this limit nor a local microbenchmark establishes a production
bandwidth ceiling. See [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Connectivity and performance limits

Cloudflare publishes a STUN endpoint at `stun.cloudflare.com:3478`. STUN
helps discover a direct path; it cannot make every NAT/firewall reachable.
CD retains its Worker WebSocket fallback for those cases. A WebSocket relay
is hosted transport, not direct P2P, and must be identified that way in
results.

Do not add standalone Cloudflare TURN under a claim that it is free:
Cloudflare documents $0.05/GB outbound for standalone TURN and
per-allocation data-rate limits around 50–100 Mbps. The documented free
exception is TURN used with their SFU. CD's file transfer does not use that
SFU. See [Cloudflare TURN](https://developers.cloudflare.com/realtime/turn/).

Endpoint CPU, disk, browser SCTP, internet bandwidth, RTT, packet loss and
firewalls still bound transfers. Published results must record endpoint
versions, verified byte counts, selected transport, timing boundaries and
network conditions. No production deployment or Cloudflare account plan
change is performed by these source changes.

## Deploy safely

Keep `new_sqlite_classes` migrations, `no_web_socket_compression`, existing
admission checks and rate limits. Ciphertext gains nothing from WebSocket
compression. The relay's 32 MiB queue guard and the clients' bounded ACK
windows protect memory; increasing them without endpoint measurements is
not a throughput fix. CD does not store file payloads in Durable Object
storage.

Run `npm run build`, `npm run typecheck`, `npm test`, `go test ./...`,
the relevant transport verifiers and `npm run deploy:dry` before release.
Deploy the isolated environment with `npx wrangler deploy --env test` to
measure real Cloudflare routing and quotas before promotion. Do not deploy
`scripts/bench-worker.wrangler.jsonc`: its relaxed limits are strictly for
local repeatable benchmarks. Confirm the account is on Workers Free in the
Cloudflare dashboard; Wrangler source alone cannot select or prove the
account's billing plan.
