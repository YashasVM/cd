# Agent sharing test matrix

CD uses its own encrypted live relay for agent-to-user transfers. It needs no
cloud storage resource or billing setup.

| Case | Action | Expected result |
|---|---|---|
| Text file | `cdx send notes.txt` | One `https://cd.yash0.in/<code>` URL on stdout |
| JSON output | `cdx send notes.txt --json` | One JSON object with a CD URL, `filename`, and `size` |
| Unicode filename | Send `résumé final.pdf` | URL is emitted without filename corruption |
| Missing relay client | Run without the `cdx` binary | Clear build/install error |
| Browser receive | Open the emitted CD URL | CD browser receives and downloads the file |
| Sender lifetime | Exit the sender before receiving | Transfer is unavailable, as expected for live mode |
