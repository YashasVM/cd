#!/usr/bin/env bash
set -euo pipefail
cd /tmp/cd-prof-run
report=/home/yvm/code/cd/docs/measurements/cd-bench-current-2026-10-20
node scripts/bench-croc-matrix.mjs --cdx /tmp/cdx-prof-isolated --croc /tmp/croc-bench-latest/croc --runs 7 --cases random-4k,random-1m,random-64m,random-256m,compressible-256m --routes auto,relay --storage disk,tmpfs --output "$report/isolated-latest.json" > "$report/isolated-latest.stdout" 2> "$report/isolated-latest.log"
CD_BROWSER_CDX=/tmp/cdx-prof-isolated CD_BROWSER_RUNS=7 CD_BROWSER_MIB=64 CD_BROWSER_OUTPUT="$report/isolated-browser.json" node scripts/bench-browser-paths.mjs > "$report/isolated-browser.stdout" 2> "$report/isolated-browser.log"
node scripts/bench-croc-lan.mjs --cdx /tmp/cdx-prof-isolated --croc /tmp/croc-bench-latest/croc --mib 128 --runs 3 --require-tcp 0 --timeout 60000 --output "$report/isolated-lan.json" > "$report/isolated-lan.stdout" 2> "$report/isolated-lan.log"
CD_LAN=0 node scripts/bench-croc-matrix.mjs --cdx /tmp/cdx-prof-isolated --croc /tmp/croc-bench-latest/croc --runs 3 --cases random-256m --routes auto,relay --storage tmpfs --output "$report/isolated-webrtc.json" > "$report/isolated-webrtc.stdout" 2> "$report/isolated-webrtc.log"
