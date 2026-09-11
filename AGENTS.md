# Agent instructions

## Sending files to a user

When a user asks an agent to send a local file through CD, read
[`skills/cd-file-sharing/SKILL.md`](skills/cd-file-sharing/SKILL.md) and follow
it. Use `cdx send <file>` and return the final URL. If `cdx` is not on `PATH`,
run `make cdx` once and use `./bin/cdx`.

Run `make croc` once if the sibling `croc` binary is missing. The sender must
stay alive until the recipient opens the link. Keep croc's code phrase private
and return only the browser URL.
