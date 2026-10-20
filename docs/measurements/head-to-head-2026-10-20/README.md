# cdx against croc, 20 October 2026

Asked for to back a promo claim that cdx is faster than other tools. Before this branch croc was faster on this laptop. The same-network TCP lane (`cmd/cdx/lan.go`) changed that for cdx-to-cdx transfers.

[`run.mjs`](run.mjs) sends the same random payload with each tool on one machine, each through its own local relay: cdx through `wrangler dev`, croc 10.7.0 through `croc relay`. Every run is SHA-256 verified. Modes run interleaved and the disk is flushed before every trial. Timing starts when the receiver is launched, after the sender is ready, and ends when the receiver exits.

Machine: 13th Gen Intel i5-13420H, 12 threads, Linux 7.2.8, AC power, performance profile, otherwise idle.

## Receivers writing to RAM (tmpfs)

This isolates the tools from the disk. 1 GiB, five runs per mode, [`results-1gib-tmpfs.json`](results-1gib-tmpfs.json):

| Mode | Median transfer | Median MiB/s | Runs (MiB/s) |
| --- | --- | --- | --- |
| cdx, this branch (same-network lane) | 0.754 s | 1358 | 1369, 1384, 1358, 1031, 607 |
| cdx, `CD_LAN=0` (WebRTC direct path, as released) | 3.212 s | 319 | 339, 328, 224, 319, 227 |
| croc, default | 4.187 s | 245 | 245, 248, 245, 228, 233 |
| croc, `--no-compress` | 1.533 s | 668 | 642, 693, 683, 662, 668 |

cdx with the lane moved the median 1 GiB in 5.6× less time than croc's defaults and 2.0× less than croc with compression off.

## Receivers writing to disk (Btrfs, zstd compression)

1 GiB, all four modes, five runs each, [`results-1gib-btrfs.json`](results-1gib-btrfs.json):

| Mode | Median MiB/s | Runs (MiB/s) |
| --- | --- | --- |
| cdx, this branch | 570 | 634, 570, 191, 20, 1013 |
| cdx, `CD_LAN=0` | 188 | 121, 188, 170, 190, 195 |
| croc, default | 245 | 245, 245, 228, 246, 239 |
| croc, `--no-compress` | 579 | 107, 142, 634, 579, 617 |

Both cdx and croc `--no-compress` had slow outliers here; this run did not yet log routes, so their cause is not established. A rerun of just those two modes, six rounds each with routes logged, had none, and every cdx run used the lane ([`results-1gib-btrfs-rerun.json`](results-1gib-btrfs-rerun.json)):

| Mode | Median transfer | Median MiB/s | Runs (MiB/s) |
| --- | --- | --- | --- |
| cdx, this branch | 0.914 s | 1122 | 1078, 1181, 1047, 1056, 1168, 1166 |
| croc, `--no-compress` | 1.634 s | 627 | 630, 633, 624, 634, 614, 616 |

cdx fsyncs the received file before reporting success; croc does not.

## What this does and does not show

Both ends share one machine, so this measures each tool's CPU and protocol overhead, not a network. On a real local network the link is usually the limit: gigabit Ethernet carries about 112 MiB/s and Wi-Fi less, and there the cdx lane and croc both use TCP. The lane removes the cost that capped the released cdx: SCTP over DTLS in userspace sends ~1.2 KB packets, which held the WebRTC path near 200–340 MiB/s here and far lower under load. The lane applies only between two cdx; browsers and the Android app keep their existing paths. Internet transfers were not compared.

Earlier loopback runs on 20 October measured 128 MiB transfers while another project's Gradle build loaded the machine (load average 3 to 19). Those numbers (cdx 36 MiB/s, croc 70 and 161) were dominated by that load and are superseded by the runs above.

Reproduce from the repository root:

```sh
H2H_DIR=/tmp H2H_MIB=1024 H2H_RUNS=5 node docs/measurements/head-to-head-2026-10-20/run.mjs
H2H_MIB=1024 H2H_RUNS=5 node docs/measurements/head-to-head-2026-10-20/run.mjs
```
