---
name: cd-file-sharing
description: Send a local file to the user (their phone, browser, or another machine) with CD. Use when asked to send, share, or hand off a file with CD or cdx.
---

# Send a file with CD

Run:

```bash
cdx send <path>...
```

Several paths or a folder arrive as one `.zip`.

It prints one line to stdout, a short share code such as `48291`, and exits 0
while a background sender keeps the transfer live. Reply to the user with that
code: they type it at https://cd.yash0.in (or run `cdx receive <code>`). The
code is valid for 15 minutes and admits one receiver. Done.

Branches:

- **Sensitive file**: run `cdx send --link <file>` and reply with the full URL
  on stdout, fragment included. Links are end-to-end encrypted; codes rely on
  TLS and the live relay.
- **User wants delivery confirmed**: run `cdx wait --timeout 10m --json <code>`
  after replying. Exit 0 means the receiver verified every byte; exit 1 means it
  failed (`errorKind` says why); exit 3 means nobody has finished yet and the
  send is still live.
- **A command fails**: with `--json`, stdout carries
  `{"error":{"kind","message"}}`. Retry `expired`, `disconnected`, `stalled` and
  `busy` with a fresh `cdx send`; report the others to the user.
- **`cdx` is not on PATH**: inside the CD repository, run `make cdx` and use
  `./bin/cdx`. Elsewhere, install it with
  `curl -fsSL https://cd.yash0.in/install.sh | sh`.

CD is self-contained: the `cdx` command is the whole integration, with its
own live relay at cd.yash0.in and no stored copies.
