# Agent sharing test matrix

CD uses croc's live encrypted relay for agent-to-user transfers. It needs no
cloud storage resource or billing setup.

| Case | Action | Expected result |
|---|---|---|
| Text file | `cdx send notes.txt` | One `https://cd.yash0.in/<code>` URL on stdout |
| JSON output | `cdx send notes.txt --json` | One JSON object with `url`, `filename`, and `size` |
| Unicode filename | Send `résumé final.pdf` | URL is emitted without filename corruption |
| Missing croc | Run with an invalid `CROC_BIN` | Clear install/path error |
| Browser receive | Open the emitted CD URL | CD redirects to croc and the browser receives the file |
| CLI receive | Run `croc <code>` | Croc CLI receives the file |
| Sender lifetime | Exit the sender before receiving | Transfer is unavailable, as expected for live mode |
