---
name: cd-file-sharing
description: Send local files and folders with cdx when asked to share or hand off a file, build, or folder.
---

# Share files with cdx

To send one or more local files or folders, run:

```sh
cdx send --json -- <path>...
```

Keep paths quoted in shell commands and place them after `--`; `cdx` bundles
multiple files and folders automatically.

Reply with:
- The 5-digit code from the JSON `code` field
- The download link `https://cd.yash0.in/#<code>` (use `CD_PUBLIC_URL` as the origin if set)
- The terminal receive command: `cdx receive <code>`

Codes expire after 15 minutes and allow one receiver. Files are not stored on
the server; keep the sender online until the transfer finishes.

## Options

- **Private link**: If the user explicitly asks for a private end-to-end
  encrypted link, add `--link` and return the exact JSON `url` (including its
  `#` fragment).
- **QR code**: If the user asks for a QR code, add `--qr /absolute/fresh.png`
  using an unused path in an existing directory, return the receive link, and
  embed the returned `qrPath` as `![Scan to receive](/absolute/fresh.png)`.
- **Wait for delivery**: Run `cdx wait --timeout 10s --json <code-or-transferId>`.
  Exit `0` confirms receipt, `1` means failure (`errorKind`), and `3` means still
  pending.

If `cdx` is missing, build it with `make cdx` in this repo (`./bin/cdx`) or
install from `https://cd.yash0.in/install.sh`. Run `cdx help send` for full
options. Report command errors using their JSON `error.kind` and `error.message`.
