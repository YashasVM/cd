# Wave 3 sink memory bound

Blob-backed downloads are limited to 256 MiB in every browser. Tier selection rejects a declared larger file when neither the file picker nor OPFS is available. Blob sinks also count actual bytes and reject a write before retaining it if cumulative data would exceed the same limit, covering missing or inaccurate size declarations.

File picker and OPFS tiers remain available for larger files. If OPFS is detected but cannot open (for example, quota or private mode), a file above the Blob limit gets an actionable message directing the user to a browser with durable storage or a save-location prompt.

Validation: `node --test src/sink.test.js` passes (13 tests). Coverage includes no-OPFS tier limits, declared oversize refusal, cumulative write-boundary rejection for both Blob sink paths, and continued large-file OPFS/file-picker selection.
