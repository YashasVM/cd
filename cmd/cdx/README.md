# cdx

Build the CLI for the current platform:

```bash
go build -o cdx .
```

Cross-compile release binaries:

```bash
GOOS=linux GOARCH=amd64 go build -o cdx-linux-amd64 .
GOOS=darwin GOARCH=arm64 go build -o cdx-darwin-arm64 .
GOOS=windows GOARCH=amd64 go build -o cdx-windows-amd64.exe .
```

`cdx` launches the sibling `croc` binary when it exists beside the executable.
Set `CROC_BIN` to use a different path. Install it with `make croc`.

`cdx send` prints a `https://cd.yash0.in/<code>` browser link and leaves the
croc sender running until the recipient accepts the transfer.
