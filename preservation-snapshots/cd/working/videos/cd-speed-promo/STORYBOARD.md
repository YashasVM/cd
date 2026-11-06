---
format: 1920x1080
duration: 28.14
mode: autonomous
message: "cdx now moves files 5× faster than croc, pairs with your phone, and has an Android app in beta"
arc: PAS → reveal on the drop → proof → feature cascade → CTA
audience: developers who move big files between their own machines
music: none
---

## Video direction

Taste direction "The sentence is the layout" (seed 576677114) on the broadside frame system, in CD's brand. Every frame is ONE lowercase sentence of four to seven words in Inter 800, flush left on the 5.5cqw margin, at most two lines. Exactly one **slot** sits inline on the type's baseline where a word would be: 1 line-height tall, 2–3 em wide, radius 0.12em, ground #1B0D09, holding a live fragment of the product built in HTML (real labels, numbers that add up). One supporting line at `lead` size sits under the sentence on the same margin. Claims carry a footnote at caption size, bottom-left.

Music: assets/music.wav, 131 BPM, beat 0.4581s, bar 1.8324s, starting four bars before the drop, so the drop lands at 7.330s. Every cut sits on a bar line (3.665s per frame = 2 bars). Sentences arrive on beat 1 of their frame; the slot's internal motion lands on beats. Words enter with a masked rise (each word from behind its own baseline, 0.35s expo.out, 1 beat stagger max); outgoing frames cut hard, no fades.

The signature move is the shutter: Frame 3's slot opens with a clip-path wipe from the left over 1.1s while its contents settle from scale 1.12 to 1. It is used once. Everywhere else slots simply appear with the sentence.

Registers: frames 1–7 dark (ground #0D0503, ink #E4D4B6, one orange element); frame 8 inverts to the orange register (ground #E58A57, ink #0D0503), echoing the opening wording. No gradients, no shadows, no hairline chrome, no mono except inside product fragments.

## Frame 1 — Still uploading?

- scene: "still [slot: a cloud upload bar crawling at 38%] uploading?" on dark
- duration: 3.665
- transition_in: cut
- status: animated
- src: compositions/frames/01-uploading.html
- type: hook
- persuasion: Pain validation
- beat: frustration
- blueprint: kinetic-type-beats
- asset_candidates:

Scene 1 (0.00–0.46): "still" rises in on beat 1. Scene 2 (0.46–1.37): the slot appears inline after "still" holding a generic upload row: a cloud glyph, "uploading film.mov", a thin bar at 37% that creeps to 38% across the frame (slow, painful). Scene 3 (1.37–3.665): "uploading?" rises on beat 4; supporting line fades up at beat 5: "Big files shouldn't wait on the cloud." The bar keeps crawling; nothing else moves.

narrativeRole: name the pain every developer knows. keyMessage: the cloud detour is slow.

## Frame 2 — Watch this

- scene: "watch [slot: terminal typing `cdx send film.mov`] this." on dark
- duration: 3.665
- transition_in: cut
- status: animated
- src: compositions/frames/02-watch.html
- type: hook
- persuasion: Curiosity gap
- beat: tension
- blueprint: typewriter-reveal
- asset_candidates:

Scene 1 (0.00–0.46): "watch" rises on beat 1. Scene 2 (0.46–2.75): the slot appears as a terminal fragment; `$ cdx send film.mov` types one character per eighth note (JetBrains Mono, cream, prompt in orange). Scene 3 (2.75–3.665): "this." rises; the caret blinks on the last two beats, the riser in the music pulls toward the drop. Supporting line: "1 GiB. cdx to cdx, same network."

narrativeRole: set up the demo; tension into the drop. keyMessage: one command.

## Frame 3 — Done before you blink

- scene: on the drop: "1 gib [slot: progress bar fills 0→100% with a 0.75 s timer] done." on dark
- duration: 3.665
- transition_in: cut
- status: animated
- src: compositions/frames/03-done.html
- type: product_intro
- persuasion: Show-don't-tell proof
- beat: awe
- blueprint: dataviz-countup
- asset_candidates:

Scene 1 (0.00–0.10): hard cut on the drop; "1 gib" is already on screen. Scene 2 (0.00–1.10): the slot SHUTTERS open from the left (the one signature move) and inside it an orange bar fills 0→100% in 0.75s while a timer counts 0.00 → 0.75 s. Scene 3 (1.10–3.665): "done." slams in on beat 3; supporting line on beat 5: "Sent in 0.75 seconds over the new same-network lane." Footnote: "1 GiB, both ends on one laptop, received to RAM, median of 5 runs."

narrativeRole: the reveal; the promise in one image. keyMessage: a gigabyte in under a second.

## Frame 4 — 5.6× faster than croc

- scene: "[slot: three bars racing] 5.6× faster than croc." on dark
- duration: 3.665
- transition_in: cut
- status: animated
- src: compositions/frames/04-croc.html
- type: key_feature
- persuasion: Statistical proof
- beat: confidence
- blueprint: dataviz-countup
- asset_candidates:

Scene 1 (0.00–0.92): the sentence "5.6× faster than croc." rises word by word on beats 1–2; "5.6×" is the orange element. Scene 2 (0.92–2.75): to the right, three labelled bars (proof column) grow from zero on beats 3–6 with their values counting up: cdx 1,358 MiB/s (orange, longest), croc --no-compress 668 MiB/s, croc default 245 MiB/s (cream-muted). Scene 3 (2.75–3.665): hold. Supporting line: "2× faster than croc even with its compression off." Footnote: "1 GiB on one laptop, received to RAM, median of 5 runs. croc 10.7.0."

narrativeRole: the proof the user asked for, with the evidence on screen. keyMessage: faster than croc, by a lot.

## Frame 5 — Pair once

- scene: "pair once. [slot: `cdx pair` QR → ✓ trusted] then just send." on dark
- duration: 3.665
- transition_in: cut
- status: animated
- src: compositions/frames/05-pair.html
- type: key_feature
- persuasion: Friction reduction
- beat: ease
- blueprint: kinetic-type-beats
- asset_candidates:

Scene 1 (0.00–0.92): "pair once." rises on beat 1. Scene 2 (0.46–2.29): the slot shows `$ cdx pair --name phone` then a small pairing QR blooms beside it; on beat 5 the QR is replaced by an orange check and "phone · trusted". Scene 3 (2.29–3.665): "then just send." rises; the supporting line types `cdx send --to phone ./film.mov`. Label: "beta".

narrativeRole: the new pairing flow. keyMessage: scan once, send forever after.

## Frame 6 — Android beta

- scene: "your phone [slot: CD Beta app receiving, progress, 'Saved to Downloads/CD'] catches it." on dark
- duration: 3.665
- transition_in: cut
- status: animated
- src: compositions/frames/06-android.html
- type: key_feature
- persuasion: Future pacing
- beat: excitement
- blueprint: device-surface-showcase
- asset_candidates:

Scene 1 (0.00–0.46): "your phone" rises. Scene 2 (0.46–2.29): the slot holds a cropped CD Beta screen at true scale: "Receiving", file row "film.mov", orange bar filling, speed in MB/s; on beat 5 it flips to "Saved to Downloads/CD". Scene 3 (2.29–3.665): "catches it." rises. Supporting line: "CD for Android is in beta. Android 10+."

narrativeRole: the Android app beta. keyMessage: your phone is a first-class receiver now.

## Frame 7 — The rest got better too

- scene: "the rest [slot: three improvements cycling] got better." on dark
- duration: 3.665
- transition_in: cut
- status: animated
- src: compositions/frames/07-release.html
- type: benefit_highlight
- persuasion: Value stacking
- beat: confidence
- blueprint: kinetic-type-beats
- asset_candidates:

Scene 1 (0.00–0.46): "the rest" rises. Scene 2 (0.46–3.20): the slot cycles three improvements, one per bar-half, each a hard swap on a beat: "direct links across networks", "browser sends that keep moving", "resumable sends to your phone". Scene 3 (0.92–3.665): "got better." rises on beat 3 and holds. Supporting line: "Plus every fix in the latest release."

narrativeRole: the rest of the release. keyMessage: everything around the speed improved too.

## Frame 8 — Get cdx

- scene: orange register: "send it with [slot: cd icon]." and the install line
- duration: 2.486
- transition_in: cut
- status: animated
- src: compositions/frames/08-cta.html
- type: cta
- persuasion: Friction reduction
- beat: urgency-to-act
- blueprint: logo-assemble-lockup
- asset_candidates: assets/cd-icon.png — CD app icon, cream "cd" with orange dot on brown-black

Scene 1 (0.00–0.46): hard cut to the orange ground on the music's final hit; "send it with [slot: cd icon]." rises in brown-black ink; the icon sits in the slot where the word "cd" would be. Scene 2 (0.46–2.486): under it, the install command `curl -fsSL https://cd.yash0.in/install.sh | sh` in a dark slot, and "cd.yash0.in" at lead size. Holds while the music rings out.

narrativeRole: the ask. keyMessage: install it now.
