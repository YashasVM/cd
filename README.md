# cd

Fast, private file handoffs: **[cd.yash0.in](https://cd.yash0.in)**

- **Anyone → anyone:** pick files in the browser or run `cdx send <file>`, share the 5-digit code, and the receiver
  types it into the **Receive** box, scans the QR code, or runs `cdx receive <code>`. Several files arrive as one .zip.

CD never stores files. Transfers are live and end-to-end encrypted.

## Install `cdx`

| Platform | Command |
| --- | --- |
| Linux / macOS | `curl -fsSL https://cd.yash0.in/install.sh \| sh` |
| Windows (PowerShell) | `irm https://cd.yash0.in/install.ps1 \| iex` |
| Go 1.26+ | `go install github.com/YashasVM/cd/cmd/cdx@latest` |

The shell installers check release checksums. The CLI is named `cdx` because `cd` is a shell builtin.

## Use

```bash
cdx send ./report.pdf          # prints a code, e.g. 48291
cdx send ./shots ./notes.md    # several paths arrive as one .zip
cdx send --link ./secret.zip   # private end-to-end encrypted link instead of a code
cdx receive 48291              # save to the current directory
cdx receive 48291 --out ~/Downloads
```

Without the CLI, type the code into the **Receive** box on [cd.yash0.in](https://cd.yash0.in).
To send from a browser to a terminal, use [cd.yash0.in/send](https://cd.yash0.in/send).

| Command | What it does |
| --- | --- |
| `cdx status [code]` | List background sends |
| `cdx wait <code>` | Exit 0 once the receiver has verified every byte, or 1 if the transfer failed |
| `cdx wait --timeout 5m <code>` | Same, but exit 3 if the receiver hasn't finished by then (the send keeps going) |
| `cdx update` | Update cdx to the latest release (checksum-verified) |
| `--json` | Machine-readable output, including `{"error":{"kind","message"}}` on failure and JSON progress lines on stderr |
| `--wait` / `--detach` | Force foreground or background sending |

**Behavior:** stdout holds only the code, and progress goes to stderr. In a terminal, `send` waits until the
receiver verifies the file. When stdout isn't a terminal (agents, scripts, pipes), it detaches as soon as
the code is live. Codes expire after 15 minutes and admit one receiver.
Files of 1 MiB or more switch to a direct WebRTC path mid-transfer when the network allows it.

**Security:** a 5-digit code lets the relay hold the transfer key so the code is easy to type, so anyone who
guesses a live code can receive the file. For sensitive files, use `--link`: the key stays in the URL fragment,
which never reaches the server. Details are in [SECURITY.md](SECURITY.md) and the [protocol spec](docs/agent-transfer-v1.md).

Agents should follow [AGENTS.md](AGENTS.md) and the [file-sharing skill](skills/cd-file-sharing/SKILL.md).

## Architecture

```text
Browser / cdx ── encrypted WebSocket ── CD relay (Durable Object) ── Browser / cdx
                └─ direct WebRTC upgrade for large files from cdx ─┘
```

One Cloudflare Worker serves the UI, signaling, relay (`/ws/v1`), and code directory (`/api/codes`).
Each transfer gets its own Durable Object room. Rooms hold one sender and one receiver, limit memory use,
expire on their own, and keep no file data.

## Develop

Requires Node.js 24+, npm, and Go 1.26.8+.

```bash
npm ci
npm run dev        # web UI
make cdx           # builds ./bin/cdx
```

Point a local CLI at a local Worker:

```bash
npx wrangler dev
CD_RELAY_URL=ws://127.0.0.1:8787/ws/v1 CD_PUBLIC_URL=http://127.0.0.1:8787 ./bin/cdx send ./README.md
```

### Checks

| Command | Covers |
| --- | --- |
| `npm test` | Browser unit tests |
| `npm run test:cli` | Go CLI tests |
| `npm run typecheck` | TypeScript |
| `npm run verify:agent` | CLI → Worker → browser, end to end in Chromium |
| `npm run verify:browser` | Browser send → browser (typed code and scanned QR) and → `cdx receive` |
| `npm run verify:terminal` | CLI ↔ CLI and browser → CLI |
| `npm run bench` | Throughput benchmarks |
| `npm run deploy:dry` | Worker bundle |

Set `CD_VERIFY_URL=https://cd.yash0.in` to run the `verify:*` scripts against production, and
`CHROMIUM_PATH` if Chromium isn't installed in a standard location.

## Deploy and release

```bash
npm run build && npx wrangler deploy           # production: cd.yash0.in
npx wrangler deploy --env test                 # staging: cd-test.yash0.in
git tag v1.2.3 && git push --tags              # builds cdx for all platforms and publishes a release
```

If something breaks in production, see [docs/production-recovery.md](docs/production-recovery.md).

## Layout

```text
cmd/cdx/   Go CLI
src/       browser UI and transfer protocols
worker/    Cloudflare Worker + Durable Object relay
scripts/   build, verify, and bench scripts
skills/    instructions for AI agents
docs/      protocol spec, recovery runbook, audit notes
```

MIT licensed. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
