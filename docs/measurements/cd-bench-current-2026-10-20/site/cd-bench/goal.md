# Prof acceptance target

Compare CD with the verified latest croc 11.5.5 release using seven interleaved repetitions for final CLI claims. Test small random inputs, 64 MiB inputs matching browser suites, 256 MiB random inputs, and compressible inputs. Record readiness, native completion, durable completion, and end-to-end completion separately. Compare both croc default and disabled compression and use the faster setting per workload.

Cover browser-to-browser, browser-to-CLI, CLI-to-browser, and CLI-to-CLI. Android performance is excluded. Browser cases include direct allowed and forced relay. Browser pages preload outside timing; receiver completion includes saving the download. Record actual path; completing over relay before ICE opens is successful automatic routing, not a transfer failure. The strict transport verification suite separately requires direct payload.

Pass criterion: every required complete scenario and timing metric is at least 1.5× faster than its named comparable latest-croc baseline, preferably 2×. Missing, failed, or incomplete required comparisons cannot pass. Browser CD versus native croc is an explicitly cross-interface reference, not a croc-browser comparison.

The goal is active. Current browser cases miss the target. Do not describe the target as achieved until the comparison data passes. Preserve encryption, authentication, sequence validation, byte limits, completion integrity, supported legacy peers, and bounded memory. Test and commit each retained improvement. Publish misses alongside wins at a.yash0.in/cd-bench.

The initial PR commit preserves the extensive preexisting sharing, transport and device implementation on which the current build depends. No Android application source is part of this PR. New performance commits are separate.


A fresh hardware check confirms a 100 Mb/s full-duplex LAN, with only 10/100 modes advertised by both the Ubuntu adapter and link partner. `lan-hardware-limit.json` computes an ideal maximum gain of 1.280× over measured croc for the random 128 MiB case. The 1.5× acceptance requirement is unchanged; meeting it requires a faster physical link. A user decision on gigabit hardware is pending.
