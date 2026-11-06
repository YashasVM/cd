# Prof acceptance target

Compare CD with the verified latest croc 11.5.5 release using seven interleaved repetitions for final CLI claims. Test small random inputs, 64 MiB inputs matching browser suites, 256 MiB random inputs, and compressible inputs. Record readiness, native completion, durable completion, and end-to-end completion separately. Compare both croc default and disabled compression and use the faster setting per workload.

Cover browser-to-browser, browser-to-CLI, CLI-to-browser, and CLI-to-CLI. Android performance is excluded. Browser cases include direct allowed and forced relay. Browser pages preload outside timing; receiver completion includes saving the download. Record actual path; completing over relay before ICE opens is successful automatic routing, not a transfer failure. The strict transport verification suite separately requires direct payload.

Pass criterion: every required complete scenario and timing metric is at least 1.5× faster than its named comparable latest-croc baseline, preferably 2×. Missing, failed, or incomplete required comparisons cannot pass. Browser CD versus native croc is an explicitly cross-interface reference, not a croc-browser comparison.

The original universal speed target is not achieved. Original native-reference browser cases miss the target. Do not describe that target as achieved until the comparison data passes. Preserve encryption, authentication, sequence validation, byte limits, completion integrity, supported legacy peers, and bounded memory. Test and commit each retained improvement. Publish misses alongside wins at a.yash0.in/cd-bench.

The report now also compares CD with croc 11.5.5's official browser client, built from its tagged source. Those matching-interface results add to the original native-croc cross-interface gates. They do not replace or weaken them. Seven alternating rounds verified 63 transfers; three matching-interface combinations pass all timing gates. Browser-to-browser direct-allowed and CLI readiness still miss gates, so the original universal target remains unmet.

The initial PR commit preserves the extensive preexisting sharing, transport and device implementation on which the current build depends. No Android application source is part of this PR. New performance commits are separate.


A fresh hardware check confirms a 100 Mb/s full-duplex LAN, with only 10/100 modes advertised by both the Ubuntu adapter and link partner. `lan-hardware-limit.json` computes an ideal maximum gain of 1.216× over measured croc for the random 128 MiB case. The 1.5× acceptance requirement is unchanged; meeting it requires a faster physical link. The user chose to continue on current hardware, then narrowed this run to practical terminal-to-browser and browser-to-terminal software improvements and asked to finish promptly. No hardware upgrade or further physical-LAN benchmarking is required for this wrap-up.

## Final scope and outcome

At the user’s request, this run closes after retaining verified software improvements, publishing the report, and committing the changes. The 1.5–2× universal target remains an unmet historical acceptance target, not a completion claim. The final browser source-copy change reduces browser-to-terminal relay median completion time by 6.8%; prior TCP buffer reuse and sender simplification are retained. Matching-browser terminal-to-browser completion is 2.65× direct-allowed and 2.96× relay versus croc, while code-readiness remains slower. Production CD is not deployed by this work.
