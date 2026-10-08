---
name: cd-file-sharing
description: Send a local file to the user (their phone, browser, or another machine) with CD. Use when asked to send, share, or hand off a file with CD or cdx.
---

# Send a file with CD

Run:

```bash
cdx send --json --qr /absolute/path/to/receive-qr.png <path>...
```

Several paths or a folder arrive as one `.zip`.

Choose a fresh PNG path in an existing directory. It prints one JSON object
with `code`, `url`, and the absolute `qrPath`, then exits 0 while a background
sender keeps the transfer live. The PNG is generated locally; no QR service is
needed. An existing output file is never overwritten.

Reply with the receive link `https://cd.yash0.in/#<code>` and embed the PNG.
In T3 Code and other chats that render local images, use an absolute-path
Markdown image (use the actual `qrPath` returned by the command):

```markdown
[Receive report.pdf](https://cd.yash0.in/#48291)

![Scan to receive report.pdf](/absolute/path/to/receive-qr.png)
```

When `CD_PUBLIC_URL` is set, use that origin instead of `https://cd.yash0.in`.
Opening the link or scanning the QR starts receiving. Both refer to the same
transfer: it is valid for 15 minutes and admits one receiver. Terminal users
can run `cdx receive <code>` instead. Keep the PNG available for the chat to
render it. If the chat cannot embed local images, reply with the link and code.

For a link without an image, `cdx send <path>...` still prints only the code
when stdout is captured. Interactive terminal sends display a QR automatically.

Branches:

- **Sensitive file**: add `--link` to the command above and reply with `url`
  from the JSON, fragment included, plus the QR image. The QR includes the same
  private link. Links are end-to-end encrypted; codes rely on
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
