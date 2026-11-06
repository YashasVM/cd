# CD and Immich transfer comparison

Measured on 2026-10-26. Results are in `results.json`, with medians in `summary.json`. `pilot-results.json` contains discarded harness-development samples, including an output filename collision. None of the pilot contributes to final scores. `failed-public-results.json` preserves the initial public-route 404 failures; the public comparison was rerun after giving cloudflared an explicit empty configuration. A version-response preflight now verifies that the public URL reaches the isolated server.

## Scope

Client PC at 192.168.1.6 over Wi-Fi to Ubuntu at 192.168.1.9. Server CPU is an AMD A4-9125 with two cores, 6.7 GiB RAM, and an ext4 filesystem on NVMe. Hardware and binary provenance are in `provenance.json`. CD is built from the current workspace, including pre-existing uncommitted changes. It is not necessarily identical to the published CD release.

A separate Docker Compose project runs the stock Immich v3.3.5 image, PostgreSQL and Valkey. It has separate data and database directories. Existing Immich deployments and libraries are untouched. The test does not use the locally modified `immich-perf` image. Machine learning is not deployed. Normal Immich metadata/thumbnail jobs may run in the background; their completion is outside the upload timing.

## Workload and verification

Three paired trials for each size and path, alternating which tool runs first. Each pair uses the exact same newly generated valid RGB PNG, with random, practically incompressible pixel data. Sizes are approximately 0.75, 12 and 48 MiB. These are synthetic media transfer workloads, not representative JPEG, HEIC or video encoding workloads. Unique contents and separate users for each method/path prevent duplicate-upload shortcuts. Every upload must return `created`. Downloading the original through Immich must reproduce the SHA-256 hash. CD output is also independently checked over SSH before import.

Immich uses authenticated multipart `POST /api/assets` via curl. Authentication and test account setup are outside timing. The official [upload guide](https://docs.immich.app/guides/python-file-upload/) documents this interface. No client-side duplicate preflight is included.

CD uses `send --wait` and an SSH-launched CLI receiver running the same compiled binary. Timing includes sender startup, share readiness, automated code handoff, receiver launch and successful sender/receiver completion. It excludes human code entry. Telemetry records the actual route. LAN enables CD direct and LAN routing; public-path tests disable both to measure hosted-relay delivery reproducibly. Public-path CD therefore measures relay fallback, not the best possible peer-to-peer internet route.

The practical CD bridge measurement adds a localhost upload from the received file to the same Immich server. That import includes a separate SSH invocation. The bridge total is the sum of CD transfer and local import durations. Independent hash verification between those steps is excluded. It is a working transport-plus-import experiment, not a patch to the Immich mobile app or server. An in-process integration could reduce process startup and avoid the localhost copy; that speedup has not been measured here.

## Paths and interpretation

LAN Immich connects directly to the server's LAN address. Public Immich connects through a temporary Cloudflare Tunnel on a random trycloudflare.com hostname. CD uses its existing hosted rendezvous/relay. The two public services can have different regions, load and network routing. Both endpoints remain on this home's network, so these measurements exercise internet service paths but do not simulate cellular, another ISP, high latency or packet loss.

The scores are relative throughput: Immich = 100; bridge score = 100 × median Immich duration / median bridge duration. Higher is better. MiB/s uses 1,048,576 bytes and includes connection/setup costs. Medians are computed separately for each timing metric. All samples remain available for variability inspection. No arbitrary 1-to-10 rating is used.

Completion means original bytes are available and accepted as an Immich asset. It does not mean thumbnails, indexing, face recognition or video transcoding are complete. Neither tool is subjected to a power-loss durability test; CD receiver exit and Immich API acknowledgement do not establish identical fsync semantics.

## Integration implications

CD delivery alone cannot replace Immich asset registration. The measured bridge keeps the upload API and its normal validation. Another supported approach is receiving into an [external library](https://docs.immich.app/features/libraries/), which Immich scans into assets. External-library scan time is not measured here. A deeper integration would need authenticated ownership, quota checks, checksums, duplicate handling, final storage placement, database records and job scheduling. These tests do not demonstrate that replacing those parts would be safe or faster.

## Reproduction

`bench.py` needs Python requests, curl, SSH/SCP access and `/tmp/cdx-immich-bench` built with `go build -o /tmp/cdx-immich-bench ./cmd/cdx`. Stage that binary as `~/immich-cd-bench-20261026/cdx` on the Linux box. Start `compose.yaml` in that remote directory. Start a temporary cloudflared tunnel to port 2286 and save its output as `tunnel.log` there. Use a fresh isolated database because the script creates its admin and users. Run `python3 docs/measurements/immich-cd-2026-10-26/bench.py`, then `python3 docs/measurements/immich-cd-2026-10-26/summarize.py`.

Credentials stay in private temporary files. The temporary admin-password file is removed after measurement. Stop the dedicated Compose project and tunnel after use. Never run database cleanup against an existing Immich installation.
