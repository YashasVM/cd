---
name: cd-file-sharing
description: Send a local file through CD when the user asks to send it using CD.
---

# CD agent file sharing

When the user asks to “send using CD” or equivalent wording:

1. Identify the local file to send.
2. Run the repository command `./bin/cdx send <file>`. If it is missing, build it once with `make cdx` and then run `./bin/cdx send <file>`.
3. Return the URL printed by `cdx` exactly as the share link.

This CD flow is local and self-contained. Do not use `CD_AGENT_TOKEN`, bearer
credentials, an upload API, R2, croc, or another provider. The link uses CD's
encrypted live relay at `https://cd.yash0.in`. Tell the user to open it promptly.
The sender process must stay alive until the receiver accepts the transfer.
Use `cdx send <file> --json` only when structured output is explicitly needed.
Never print, quote, or expose the agent bearer token or the temporary upload URL.
