# cdx

`cdx` is CD's foreground agent-to-browser sender.

```bash
go install github.com/YashasVM/cd/cmd/cdx@latest
cdx send ./file.zip
```

The command prints one `https://cd.yash0.in/s/<id>#v1.<key>` URL after the
relay accepts the sender. Send that full link to the receiver and keep `cdx`
running until they verify the file. Status goes to standard error, making the
single stdout line safe for agents and shell scripts. `cdx send ./file.zip --json`
(or `cdx send --json ./file.zip`) emits the same invitation with filename,
byte size, and output schema version.

Rules for v1:

- One regular file per invocation. Zip a folder first to share it.
- Flags may come before or after the file path.
- Exit status `0` means the browser verified every byte, `1` means the
  transfer failed, `2` means the command was used incorrectly.

For local repository builds, run `make cdx` from the repository root.
