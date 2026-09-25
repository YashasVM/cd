---
name: cd-file-sharing
description: Send a local file through CD when the user asks to send or share it with CD.
---

# Send a file through CD

1. Resolve the requested local file and confirm it is a regular file.
2. Run `make cdx` from the repository root so `./bin/cdx` matches the source.
3. Start `./bin/cdx send <file>` in a long-lived or streaming shell session.
4. Read its first stdout line and immediately return that short share code to
   the user. Do not wait for the process to exit before replying.
5. Keep the sender process and shell session alive. Exit status 0 means the
   receiver verified the full transfer; a nonzero status is a real failure.

The code works in any browser Receive box and in `cdx receive <code>`. Tell
the user to share it promptly: codes expire after 15 minutes and admit one
receiver. Do not log the code anywhere else.

For a sensitive file, send with `./bin/cdx send --link <file>` instead and
return the complete URL (fragment included); that mode stays end-to-end
encrypted, while plain codes rely on TLS and the live relay.

This operation is local and self-contained. Do not look for credentials, an
upload API, object storage, croc, or another provider. CD uses its own
live relay at `cdx.yash0.in` and never uploads the file for later storage.

Use `--json` only when the caller explicitly needs structured output. In that
mode, parse the first JSON object and return its `code` field (`url` is also
present when `--link` was used).
