---
name: cd-file-sharing
description: Send a local file to the user with CD. Use when asked to send, share, or hand off a file with CD or cdx.
---

# Share files

Run `cdx send <path>...` and reply with `https://cd.yash0.in/#<code>` using the
printed code. Terminal recipients can run `cdx receive <code>`. To share
several files, pass them all to one `cdx send` (do not zip them yourself): one
code delivers them, and they arrive as separate files with folders kept.
Captured sends return promptly while a
background sender stays live. No account or stored server copy is needed;
both devices must be online. A code lasts 15 minutes and admits one receiver.

For sensitive files, run `cdx send --link --json <path>...` and reply with the
returned `url`, including its fragment. Private links are end-to-end encrypted;
codes rely on TLS and the live relay. Use the `CD_PUBLIC_URL` origin when set.

For a QR image, add `--json --qr /absolute/fresh.png` (existing directory,
unused filename). Reply with the returned `url` and embed the actual `qrPath`:

```markdown
[Receive file](https://cd.yash0.in/#48291)
![Scan to receive](/absolute/fresh.png)
```

Keep the PNG available for rendering. If local images cannot be embedded,
reply with the link and code. JSON results are one compact stdout line;
progress requires `--progress` and goes to stderr. `--wait` keeps a send in
the foreground.

If delivery confirmation is requested, run `cdx wait --timeout 10m --json <code>`.
Exit 0 means verified delivery, 1 means failure (`errorKind` explains it), and
3 means the timeout elapsed while the send remains live. On command failure,
read the JSON `error.kind` and `error.message`; report actionable details.
Do not claim delivery just because the send returned a code.

If cdx is unavailable, run `make cdx` in this repository and use `./bin/cdx`.
Elsewhere install with `curl -fsSL https://cd.yash0.in/install.sh | sh`.
See `cdx help send` for options.
