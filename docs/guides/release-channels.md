# CLI release channels

Stable and nightly install side by side. Stable uses `cdx`; nightly uses `cdx-nightly`.

```sh
curl -fsSL https://cd.yash0.in/install.sh | sh
curl -fsSL https://cd.yash0.in/install.sh | CD_CHANNEL=nightly sh
```

On Windows, set `$env:CD_CHANNEL = 'nightly'` before running the PowerShell installer. Remove that variable or set it to `stable` for the stable CLI.

`cdx update` selects the newest published stable release and excludes prereleases. `cdx-nightly update` reinstalls the current rolling nightly build. It never replaces `cdx`. Nightly does not show automatic update notices; run its update command explicitly.

Nightly builds run daily at 02:30 UTC from the default branch, or manually through the Release cdx nightly workflow. They publish six platform binaries and checksums under the `nightly` prerelease. Stable releases use version tags and their own binaries. Beta version tags remain prereleases and are excluded from stable updates.

Existing CLI installations need a one-time installer run to acquire channel support. Nightly builds can contain unfinished changes.
