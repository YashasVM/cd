# `cdx` v1 release design

## Release contract

The first supported release path is one regular file from the `cdx` command to
one browser receiver. The command accepts paths with spaces and Unicode names,
prints one private `https://cd.yash0.in` capability URL to stdout as soon as the
relay admits the sender, and keeps running until the browser verifies every
byte.

Status belongs on stderr. Exit status `0` means the receiver verified the full
file, `1` means the transfer failed, and `2` means the command was invalid.
Agents must return the first stdout line promptly and keep the process alive.
They must not place the command in a substitution or log the URL fragment.

The full URL is the receiver code. A shorter manually typed code would need a
new password-authenticated key exchange; truncating the current capability
would weaken it.

## System shape

Keep the protocol, sender, Worker, and browser receiver as the four release
boundaries. The current modules remain flat because splitting them adds reader
work without improving the contract.

- The CLI validates one regular file and constructs same-origin relay and
  public endpoints.
- The Worker admits one sender and one authorized receiver per random room. It
  forwards bounded encrypted records and stores no file contents.
- The browser removes the key fragment from visible history, asks for consent,
  persists each chunk before acknowledging it, and verifies terminal counts.
- CI builds the actual CLI, starts the actual Worker, drives the built browser
  receiver in Chromium, downloads the result, and compares exact bytes.

There is no resume support in v1. A disconnected transfer fails clearly and can
be restarted with a new capability URL. Browser-to-browser WebRTC and Android
remain separate clients, not dependencies of the `cdx` release contract.

## Design decision

Two independent designs converged on this narrow supported path. The selected
design contributes the end-to-end boundary and same-origin invariant. The
alternate design contributes explicit exit semantics, private-link handling,
idempotent teardown, and adversarial cases. Proposed package splits and a new
JSON output schema were rejected because the existing interfaces already make
the supported path easy to follow and automate.

## Release evidence

Before tagging, run the JavaScript tests, Go tests and vet, TypeScript check,
production build, dependency audit, Worker dry deployment, browser end-to-end
verification, Android test/lint/build, and the six-platform CLI release build.
Run the browser verification again to catch leaked process or room state. Check
that a release binary reports the tag supplied through `VERSION` and publish
its SHA-256 checksum with the GitHub release.
