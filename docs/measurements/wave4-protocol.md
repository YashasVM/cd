# Wave 4 resume protocol verification

The shared v2 record fixture is byte-for-byte identical in Go and JavaScript for sender and receiver records. The fixture also covers receiver-token derivation and hash, sender nonce proof, and receiver checkpoint MAC. Both language suites validate the fixture directly.

`node --test src/resume-protocol.test.js src/incremental-sha256.test.js` passed 4 focused tests. The full `npm test` run passed all 72 tests. Coverage includes distinct ciphertext when either session nonce changes, wrong-nonce authentication failure without consuming the sequence number, checkpoint tamper and expiry rejection, and incremental SHA-256 across block and padding boundaries against Node's SHA-256 implementation.

`go test ./...` passed. `npm run typecheck -- --pretty false` passed. `node scripts/verify-resume-auth.mjs` passed against a local Wrangler Worker and Durable Object. It exercises invalid sender admission, wrong receiver token, session interruption, wrong sender token on reconnect, replayed session nonce, fresh-session recovery, encrypted COMPLETE forwarding, completion acknowledgement, and terminal-root rejection.

The browser bundle built successfully as part of `npm run verify:resume-auth`. The local relay test uses no new Durable Object binding or migration; v2 roots use the existing `TRANSFERS` binding with a `v2:` name prefix and persist under a separate storage key.

## Integrated security review

The coordinator integration (`2221bf5`, `427c917`) passed the focused CLI, browser primitive, and local relay auth checks: `go test ./cmd/cdx`, `node --test src/resume-browser.test.js src/resume-protocol.test.js src/incremental-sha256.test.js` (8 tests), and `node scripts/verify-resume-auth.mjs`.

Code review found outstanding integration blockers that these suites do not cover:

- The browser sender verifies its saved checkpoint MAC but does not compare the reselected file's name, size, and whole-file digest with that checkpoint before sending. A different file can therefore be offered under the existing root when the receiver has no retained checkpoint.
- CLI expiry is not bound to the relay's root expiry. The CLI sender advertises an expiry created before relay admission, while the browser receiver requires exact equality with the relay event. This rejects CLI-to-browser transfers. The CLI receiver also accepts a future offer expiry without checking that it matches the relay's fixed expiry.
- Browser cancellation can race asynchronous stage/checkpoint writes. Receiver cancellation before `stage` assignment can leave a subsequently created stage, and cancellation during an append can remove the stage before append persists a new checkpoint. Sender cancellation during hashing or a pending checkpoint write can likewise recreate deleted local capability state. CLI sender cancellation also leaves its local capability/checkpoint behind.
- Browser expired-record cleanup always inspects the first 128 ordered checkpoint keys. If those remain live, later expired staging records are starved on every startup. Expired sender secrets with no checkpoint are not visited by the checkpoint-only sweep.

These are review findings, not covered acceptance results, and need fixes in the owning CLI/browser files before the end-to-end security gate is complete.
