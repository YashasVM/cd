# CD highway acceptance checks

Canonical effort: [CD highway: trusted, resumable Android and Linux transfers](https://github.com/YashasVM/cd/issues/9).

This is a release checklist, not a claim that the highway is implemented.

## Agreed behavior

- Android app and a Linux background service.
- All explicitly trusted senders can send without a per-transfer acceptance prompt.
- Both endpoints must be available; no server-side file storage or delayed delivery is required.
- After enrollment, local handoffs must work with internet access disconnected.
- Internet routes may use free hosted services, including Clerk and Cloudflare. Paid usage is prohibited.
- Interrupted transfers retain verified progress across reconnects, route changes, and process restart.

## Required evidence before calling the product finished

| Scenario | Required result |
| --- | --- |
| Fresh installation | Install Android package and Linux client; authenticate, enroll devices and establish trust without manually copying transfer codes. |
| Offline LAN | After enrollment, disconnect WAN access; start a new transfer in each direction and verify final size and SHA-256. |
| Internet | Put devices on separate networks; verify direct connection where available and configured relay fallback where needed. |
| Free limits | Exhaust an injected quota; stop cleanly, retain progress, and do not enable a paid fallback. Verify actual service plans separately. |
| Network change | Interrupt Wi-Fi mid-file, change route, reconnect and verify resumed bytes and final digest. |
| Process death | Terminate each endpoint independently mid-file; restart and resume using durable checkpoints. |
| Corruption | Alter a chunk or staged bytes; reject corruption and never publish a completed destination file. |
| Source change | Modify or replace the source after interruption; reject an incompatible resume. |
| Authentication | Reject unknown sender keys, forged discovery advertisements, expired credentials, replayed handshakes and wrong-recipient transfers. |
| Revocation | Reject revoked senders after revocation is known; measure and document the chosen offline revocation window. |
| Storage | Handle insufficient disk space, destination collisions, URI permission loss and large files without whole-file RAM buffering. |
| Android lifecycle | Exercise screen-off, Doze, background restrictions, app restart, reboot and force-stop on the actual target phone; document unsupported wake cases. |
| Power | Measure idle and active-transfer consumption against the same device baseline; record duration, screen/network conditions, wake locks and OS versions. |

## Baseline checked during charting

On 2026-09-17 the existing working tree passed 27 JavaScript tests, TypeScript checking, Go tests, and the existing CLI/Worker/browser end-to-end transfer of 1,572,937 byte-identical bytes. Go required `mise exec go@1.26.8 -- ...` because the unconfigured shim could not select a version.

These checks exercise the existing handoff flow. They do not validate trusted background reception, offline discovery, automatic route switching, or durable resume.

## Decisions still required

See the map's native child issues for background availability/power targets, the shared authenticated transfer contract, and release prerequisites. Device power targets must be measured rather than described as “minimum battery” without a workload and baseline.
