# cdx

`cdx` is CD's foreground terminal sender and receiver. One binary, one host
(`cd.yash0.in`): terminal↔browser, browser↔browser (relay), and
terminal↔terminal all speak the same encrypted relay protocol, while
browser↔browser can also use direct WebRTC from the same page.

```bash
go install github.com/YashasVM/cd/cmd/cdx@latest
cdx send ./file.zip
# prints e.g. 48291
cdx receive 48291 --out ./downloads/
```

When a newer release is available, terminal commands show a notice with
`cdx update`. The check runs at most once an hour and times out after 750 ms;
offline checks stay silent. Notices go to stderr, so captured share codes and
JSON remain unchanged. Set `CD_NO_UPDATE_CHECK=1` to disable the check.

Or install the latest checksum-verified release without Go. On Linux or
macOS:

```bash
curl -fsSL https://cd.yash0.in/install.sh | sh
```

On Windows (PowerShell):

```powershell
irm https://cd.yash0.in/install.ps1 | iex
```

Sending prints one short share code after the relay accepts the sender. The
receiver types it into the browser Receive box or runs `cdx receive <code>`.
Codes expire after 15 minutes and admit one receiver. Status goes to standard
error, making the single stdout line safe for agents and shell scripts.
`cdx send ./file.zip --json` emits the code with the filename, byte size, and
output schema version. A bare `cdx ./file.zip` works as shorthand for
`cdx send ./file.zip`.

When stdout is not a terminal, `send` detaches: it re-executes itself as a
background holder in a new session (Windows: a detached process group) and
exits 0 once the holder prints the code. The holder records its progress in
`<user cache dir>/cdx/transfers/<code>.json` (override with `CD_STATE_DIR`)
and logs to a file beside it. `cdx wait <code>` blocks until the receiver
verifies the file (exit 0) or the transfer fails (exit 1), including when the
holder process died. `cdx status [code]` prints `<code> <phase> <file>` lines
(`--json` for objects). `--wait` forces the foreground and `--detach` forces
the background.

Receiving takes the code (a full share link works too), saves the offered
file, and prints the saved path to stdout (`--json` emits the filename, size,
and path instead). The sender can be another `cdx send` or a browser on the
`/send` page; the receiver enforces the same filename, size, and chunk
contract the browser share page uses. `--out` picks the destination file or
directory, `--force` overwrites.

Short codes are typable but not end-to-end encrypted: the relay directory
holds the transfer key, so the code relies on TLS and the live relay. For
sensitive files, `cdx send --link ./file.zip` prints a private
`https://cd.yash0.in/s/<id>#v1.<key>` link instead, whose fragment key never
reaches the server.

Rules for v1:

- One path sends that file as-is. A folder, or several paths, is streamed as
  one uncompressed `.zip` built on the fly (its exact size is computed up
  front, since the protocol offers a known size). Symlinks inside folders are
  skipped, not followed. A file that changes size mid-send fails the
  transfer.
- Flags may come before or after the file path. Use `--` before a file whose
  name starts with `-` (for example `cdx send -- -weird-name.bin`).
- `cdx --help`, `cdx help send`, `cdx help receive`, and `cdx --version`
  document the rest.
- The binary is `cdx`, not `cd`: a `cd` binary is shadowed by the shell
  builtin in every non-interactive shell.
- Exit status `0` means the transfer verified every byte (`send`: the receiver
  verified; `receive`: the file was written and acknowledged), `1` means the
  transfer failed, `2` means the command was used incorrectly.

For local repository builds, run `make cdx` from the repository root.
