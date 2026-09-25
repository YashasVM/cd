# cdx

`cdx` is CD's foreground terminal sender and receiver.

```bash
go install github.com/YashasVM/cd/cmd/cdx@latest
cdx send ./file.zip
# prints e.g. 48291
cdx receive 48291 --out ./downloads/
```

Sending prints one short share code after the relay accepts the sender. The
receiver types it into the browser Receive box or runs `cdx receive <code>`.
Codes expire after 15 minutes and admit one receiver. Status goes to standard
error, making the single stdout line safe for agents and shell scripts.
`cdx send ./file.zip --json` emits the code with the filename, byte size, and
output schema version. A bare `cdx ./file.zip` works as shorthand for
`cdx send ./file.zip`.

Receiving takes the code (a full share link works too), saves the offered
file, and prints the saved path to stdout (`--json` emits the filename, size,
and path instead). The sender can be another `cdx send` or a browser on the
`/send` page; the receiver enforces the same filename, size, and chunk
contract the browser share page uses. `--out` picks the destination file or
directory, `--force` overwrites.

Short codes are typable but not end-to-end encrypted: the relay directory
holds the transfer key, so the code relies on TLS and the live relay. For
sensitive files, `cdx send --link ./file.zip` prints a private
`https://cdx.yash0.in/s/<id>#v1.<key>` link instead, whose fragment key never
reaches the server.

Rules for v1:

- One regular file per invocation. Zip a folder first to share it.
- Flags may come before or after the file path. Use `--` before a file whose
  name starts with `-` (for example `cdx send -- -weird-name.bin`).
- `cdx --help`, `cdx help send`, `cdx help receive`, and `cdx --version`
  document the rest.
- Exit status `0` means the transfer verified every byte (`send`: the receiver
  verified; `receive`: the file was written and acknowledged), `1` means the
  transfer failed, `2` means the command was used incorrectly.

For local repository builds, run `make cdx` from the repository root.
