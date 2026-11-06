#!/usr/bin/env bash
set -euo pipefail
# Prepare once from the repository root before timing:
# git worktree add --detach /tmp/cd-prof-final-run 806bb37
# ln -s /home/yvm/code/cd/node_modules /tmp/cd-prof-final-run/node_modules
# In that checkout: npm run build && go build -o /tmp/cdx-prof-final ./cmd/cdx
# ./node_modules/.bin/wrangler deploy --dry-run --config scripts/bench-worker.wrangler.jsonc --outdir /tmp/cd-prof-final-worker
# Validate latest croc and its upstream checksums before using the staged binary.
cd /tmp/cd-prof-final-run
export CD_BENCH_RUNTIME_BUNDLE=/tmp/cd-prof-final-worker/index.js
export CD_BENCH_NO_COMPRESSION=1
report=/home/yvm/code/cd/docs/measurements/cd-bench-current-2026-10-20
node scripts/bench-croc-matrix.mjs --cdx /tmp/cdx-prof-final --croc /tmp/croc-bench-latest/croc --runs 7 --cases random-4k,random-1m,random-64m,random-256m,compressible-256m --routes auto,relay --storage disk,tmpfs --output "$report/final-latest.json" > "$report/final-latest.stdout" 2> "$report/final-latest.log"
CD_BROWSER_CDX=/tmp/cdx-prof-final CD_BROWSER_RUNS=7 CD_BROWSER_MIB=64 CD_BROWSER_OUTPUT="$report/final-browser.json" node scripts/bench-browser-paths.mjs > "$report/final-browser.stdout" 2> "$report/final-browser.log"
node scripts/bench-croc-lan.mjs --cdx /tmp/cdx-prof-final --croc /tmp/croc-bench-latest/croc --mib 128 --runs 3 --require-tcp 0 --timeout 60000 --output "$report/final-lan.json" > "$report/final-lan.stdout" 2> "$report/final-lan.log"
CD_LAN=0 node scripts/bench-croc-matrix.mjs --cdx /tmp/cdx-prof-final --croc /tmp/croc-bench-latest/croc --runs 3 --cases random-256m --routes auto,relay --storage tmpfs --output "$report/final-webrtc.json" > "$report/final-webrtc.stdout" 2> "$report/final-webrtc.log"
node scripts/prof-gates.mjs "$report/final-latest.json" "$report/final-browser.json" "$report/final-lan.json" "$report/final-gates.json" > "$report/final-gates.stdout"
