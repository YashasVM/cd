# Agent instructions

## Sending files to a user

When a user asks an agent to send a local file through CD, read
[`skills/cd-file-sharing/SKILL.md`](skills/cd-file-sharing/SKILL.md) and follow
it. Use `cdx send <file>` and return the final URL. If `cdx` is not on `PATH`,
run `make cdx` once and use `./bin/cdx`.

The sender must stay alive until the recipient opens the link. Keep the URL
fragment private and return the complete CD browser URL.
