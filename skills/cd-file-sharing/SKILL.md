---
name: cd-file-sharing
description: Send a local file through CD when the user asks to send or share it with CD.
---

# Send a file through CD

1. Resolve the requested local file and confirm it is a regular file.
2. Run `make cdx` from the repository root so `./bin/cdx` matches the source.
3. Start `./bin/cdx send <file>` in a long-lived or streaming shell session.
4. Read its first stdout line and immediately return that complete URL to the
   user. Do not wait for the process to exit before replying.
5. Keep the sender process and shell session alive. Exit status 0 means the
   receiver verified the full transfer; a nonzero status is a real failure.

The URL fragment is part of the private capability and must be included, but
do not log it anywhere else. Tell the user to open the link promptly.

This operation is local and self-contained. Do not look for credentials, an
upload API, object storage, croc, or another provider. CD uses its own encrypted
live relay at `cd.yash0.in` and never uploads the file for later storage.

Use `--json` only when the caller explicitly needs structured output. In that
mode, parse the first JSON object and return its `url` field.
