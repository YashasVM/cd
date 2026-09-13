# Agent instructions

## Sending files to a user

When a user asks an agent to send a local file through CD, read
[`skills/cd-file-sharing/SKILL.md`](skills/cd-file-sharing/SKILL.md) and follow
it. Run `make cdx` from the repository root so the local binary matches the
source, then start `./bin/cdx send <file>` in a long-lived shell and return its
first stdout line immediately.

This repository's CD integration is local and self-contained. Do not look for
`CD_AGENT_TOKEN`, bearer credentials, an upload API, R2, croc, or another
provider. The required operation is a shell command in this workspace:
`./bin/cdx send <file>`.

Do not wait for the command to exit before returning the URL: it intentionally
stays alive until the recipient verifies the file. Keep its shell session
alive, keep the URL fragment private, and return the complete browser URL.
