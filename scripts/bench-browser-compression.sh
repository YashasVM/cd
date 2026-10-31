#!/usr/bin/env bash
set -euo pipefail
# Run from a clean Prof checkout. The two suites differ only in the runtime flag.
bench_dir=$(mktemp -d /tmp/cd-compression-XXXXXX)
trap 'rm -rf "$bench_dir"' EXIT
report_dir=${CD_COMPRESSION_REPORT_DIR:-/tmp}
mkdir -p "$report_dir"
npm run build
go build -o "$bench_dir/cdx" ./cmd/cdx
npx wrangler deploy --dry-run --config scripts/bench-worker.wrangler.jsonc --outdir "$bench_dir/worker"
CD_BENCH_RUNTIME_BUNDLE="$bench_dir/worker/index.js" CD_BROWSER_CDX="$bench_dir/cdx" CD_BROWSER_RUNS=7 CD_BROWSER_OUTPUT="$report_dir/compression-before-browser.json" node scripts/bench-browser-paths.mjs
CD_BENCH_RUNTIME_BUNDLE="$bench_dir/worker/index.js" CD_BENCH_NO_COMPRESSION=1 CD_BROWSER_CDX="$bench_dir/cdx" CD_BROWSER_RUNS=7 CD_BROWSER_OUTPUT="$report_dir/compression-after-browser.json" node scripts/bench-browser-paths.mjs
