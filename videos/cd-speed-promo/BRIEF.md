---
workflow: product-launch-video
flow: automation
storyboard: no
mode: autonomous
message: "cdx now moves files 5× faster than croc, pairs with your phone, and has an Android app in beta"
destination: youtube
aspect: 1920x1080
language: en
length: 30
angle: speed-first release reveal
---

## Intent

A new, high-energy promo for CD's latest release, cut to upbeat music. The user asked for: the new improvement release, `cdx pair`, the Android app beta, and "wayy faster speeds than anyone on the market". Speed leads. No voiceover. Use the taste skill (Leonxlnx/taste-skill, installed in `.agents/skills/`) for design direction.

## Assets

- ../../public/icon-512.png — CD app icon, opener and closing lockup.
- ../../docs/measurements/head-to-head-2026-10-20 (branch perf/beat-croc) — the benchmark the speed claims come from.

## Customizations

- Bar race and count-up for the cdx vs croc result.
- Upbeat instrumental music bed; cuts land on the beat.

## Notes

- Speed claims, with on-screen footnote. 1 GiB on one laptop, receivers writing to RAM, median of 5 runs. cdx 1,358 MiB/s, croc 10.7.0 defaults 245 MiB/s (5.6×), croc --no-compress 668 MiB/s (2.0×). On disk: cdx 1,122 vs croc --no-compress 627.
- Do not claim "faster than anyone on the market". The evidence covers croc only. The user chose to benchmark against croc and then to make cdx faster first.
- The speedup is a same-network TCP lane between two cdx, committed on branch perf/beat-croc and not yet released. The video must not be published until the lane ships.
- `cdx pair` and the Android app are in beta (v0.4.0-beta.1). Label them as beta.
- The v0.3.6 release fixed cross-network direct connections and browser transfer stalls.
