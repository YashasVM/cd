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

`cdx send` prints a `https://cd.yash0.in/<code>#<key>` browser link and leaves
the CD sender running until the recipient accepts the transfer.
