#!/usr/bin/env bash
set -euo pipefail
cd /home/yvm/code/cd
report=docs/measurements/cd-bench-current-2026-10-20
node scripts/bench-croc-matrix.mjs --cdx /tmp/cdx-benchmark-current --croc /tmp/croc-bench-latest/croc --runs 7 --cases random-4k,random-1m,random-256m,compressible-256m --routes auto,relay --storage disk,tmpfs --output "$report/latest.json" > "$report/latest.stdout" 2> "$report/latest.log"
node scripts/bench-croc-lan.mjs --cdx /tmp/cdx-benchmark-current --croc /tmp/croc-bench-latest/croc --mib 128 --runs 3 --require-tcp 0 --timeout 60000 --output "$report/lan.json" > "$report/lan.stdout" 2> "$report/lan.log"
CD_LAN=0 node scripts/bench-croc-matrix.mjs --cdx /tmp/cdx-benchmark-current --croc /tmp/croc-bench-latest/croc --runs 3 --cases random-256m --routes auto,relay --storage tmpfs --output "$report/webrtc-diagnostic.json" > "$report/webrtc.stdout" 2> "$report/webrtc.log"
