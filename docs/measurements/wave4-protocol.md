# Wave 4 resume protocol verification

The shared v2 record fixture is byte-for-byte identical in Go and JavaScript for sender and receiver records. The fixture also covers receiver-token derivation and hash, sender nonce proof, and receiver checkpoint MAC. Both language suites validate the fixture directly.

`node --test src/resume-protocol.test.js src/incremental-sha256.test.js` passed 4 focused tests. The full `npm test` run passed all 72 tests. Coverage includes distinct ciphertext when either session nonce changes, wrong-nonce authentication failure without consuming the sequence number, checkpoint tamper and expiry rejection, and incremental SHA-256 across block and padding boundaries against Node's SHA-256 implementation.

`go test ./...` passed. `npm run typecheck -- --pretty false` passed. `node scripts/verify-resume-auth.mjs` passed against a local Wrangler Worker and Durable Object. It exercises invalid sender admission, wrong receiver token, session interruption, wrong sender token on reconnect, replayed session nonce, fresh-session recovery, encrypted COMPLETE forwarding, completion acknowledgement, and terminal-root rejection.

The browser bundle built successfully as part of `npm run verify:resume-auth`. The local relay test uses no new Durable Object binding or migration; v2 roots use the existing `TRANSFERS` binding with a `v2:` name prefix and persist under a separate storage key.
