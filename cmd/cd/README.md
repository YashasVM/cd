# cd

`cd` is CD's foreground terminal sender and receiver. One binary, one host
(`cd.yash0.in`): terminal↔browser, browser↔browser (relay), and
terminal↔terminal all speak the same encrypted relay protocol, while
browser↔browser can also use direct WebRTC from the same page.

```bash
go install github.com/YashasVM/cd/cmd/cd@latest
eval "$(cd shell-init)"   # once: lets `cd send` bypass the shell builtin
cd send ./file.zip
# prints e.g. 48291
cd receive 48291 --out ./downloads/
```

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
receiver types it into the browser Receive box or runs `cd receive <code>`.
Codes expire after 15 minutes and admit one receiver. Status goes to standard
error, making the single stdout line safe for agents and shell scripts.
`cd send ./file.zip --json` emits the code with the filename, byte size, and
output schema version. A bare `cd ./file.zip` works as shorthand for
`cd send ./file.zip`.

Receiving takes the code (a full share link works too), saves the offered
file, and prints the saved path to stdout (`--json` emits the filename, size,
and path instead). The sender can be another `cd send` or a browser on the
`/send` page; the receiver enforces the same filename, size, and chunk
contract the browser share page uses. `--out` picks the destination file or
directory, `--force` overwrites.

Short codes are typable but not end-to-end encrypted: the relay directory
holds the transfer key, so the code relies on TLS and the live relay. For
sensitive files, `cd send --link ./file.zip` prints a private
`https://cd.yash0.in/s/<id>#v1.<key>` link instead, whose fragment key never
reaches the server.

Rules for v1:

- One regular file per invocation. Zip a folder first to share it.
- Flags may come before or after the file path. Use `--` before a file whose
  name starts with `-` (for example `cd send -- -weird-name.bin`).
- `cd --help`, `cd help send`, `cd help receive`, `cd shell-init`, and
  `cd --version` document the rest.
- `cd` shadows the shell builtin by name: run `eval "$(cd shell-init)"`
  once (or call `command cd send …`) so subcommands reach the binary.
  All other uses fall through to the builtin.
- Exit status `0` means the transfer verified every byte (`send`: the receiver
  verified; `receive`: the file was written and acknowledged), `1` means the
  transfer failed, `2` means the command was used incorrectly.

For local repository builds, run `make cd` from the repository root.
