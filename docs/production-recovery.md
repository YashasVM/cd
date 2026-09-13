# CD production recovery

## Definition of done

CD is ready when a clean checkout can build the web app and CLI, a sender can run
`cdx send <file>` and receive one `https://cd.yash0.in` capability URL only after
the relay accepts the sender, and a phone-sized browser can use that URL to save
the exact bytes. The sender must remain available until completion or a clear
timeout. The relay must never receive the URL-fragment key or plaintext file
content. Automated checks must cover protocol success, disconnect, invalid
input, duplicate roles, mismatch, and corrupted content. Release QA also
exercises the actual browser consent and download UI at phone and desktop sizes.

## Grounding

The repository has three transfer paths:

- `src/main.js` owns browser-to-browser WebRTC, coordinated by CD signaling.
- `cmd/cdx` owns agent-to-browser sending over a Cloudflare WebSocket relay.
- `worker/index.ts` routes each agent transfer to one Durable Object and serves
  the Vite assets.

The previous agent path generated a four-word route and a 256-bit AES-GCM key.
The key was placed after `#`, but a detached child connected later, encrypted
independent chunks, and sent them as base64 text. The browser decrypted every
message and built one unbounded Blob in memory.

The deployed small-file happy path passed on 2026-09-12. The current checks do
not prove the system is production-ready:

- The parent prints a URL before the detached sender has connected.
- Detached sender errors have no durable destination and no caller-visible
  readiness result.
- Async browser message handlers can finish decryption out of order.
- Every file is duplicated in browser memory as encrypted text, decoded bytes,
  decrypted chunks, and the final Blob.
- The relay silently ignores extra senders, extra receivers, and invalid peers.
- The protocol has no version, byte-count verification, flow control, terminal
  acknowledgement, or useful close reasons.
- The route space has about 20 bits because it uses four choices from 33 words.
- The only CLI test checks the number of words. There is no relay or browser
  end-to-end test and no release automation.

## Chosen scope

This recovery keeps the browser-to-browser WebRTC transport, while replacing
its enumerable word route with a random 128-bit fragment capability and adding
strict manifest, filename, size, ordering, memory, and completion checks. It
replaces the agent-to-browser relay protocol and CLI lifecycle, then adds
install and release support. The CLI-to-browser path uses Cloudflare only as a
live ciphertext forwarder. It does not add file storage, user accounts, a
second domain, or croc compatibility.

## Work units

1. Capture the current build and hosted small-file baseline.
2. Design the wire states and public CLI contract twice, then select one design.
3. Add protocol and relay tests that fail against the prototype.
4. Implement a versioned binary protocol and bounded receiver flow control.
5. Replace detached-process behavior with an observable, portable foreground
   lifecycle.
6. Make the browser save path ordered, size-checked, responsive, and clear on
   phone-sized screens.
7. Add a deterministic local CLI-to-browser verification command.
8. Add reproducible release binaries and concise installation documentation.
9. Run local runtime checks, a production dry run, and the hosted flow where the
   available deployment matches the code under test.
10. Move WebRTC signaling from the public PeerJS service into a bounded CD
    Durable Object so both product paths stay on `cd.yash0.in`.

## Rigor

High. The protocol handles untrusted network data and large user files, while a
bad lifecycle decision makes an agent print unusable links. Each work unit must
end in an executable check. Deployment is not part of the reversible code edit
and requires a separate production decision after local proof.
