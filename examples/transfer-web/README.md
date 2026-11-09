# Web host example

Build and serve the sample on the same origin as a local relay:

```sh
npm ci
npx vite build examples/transfer-web --outDir ../../build/transfer-web-example
npx wrangler dev --assets build/transfer-web-example
```

Open the local URL printed by Wrangler in two browser windows. This example
uses only the package API. No CD app or account is required. HTTP is allowed
only on localhost and private IP addresses. Hosted use needs HTTPS.

The current relay accepts same-origin browser connections. Deploy the host's
bundle as assets on its own relay, or use an operator-controlled same-origin
WebSocket gateway. Cross-origin pages cannot connect directly to the public CD
relay. This PR changes no production origin policy and deploys no service.

Choose a file and Send in one window; copy the invitation to the other and
Receive. The host asks for consent before creating a private OPFS sink. Confirm
that both sides display the same size and SHA-256. Try Reject, Cancel, closing
a tab, disabling the network and sending a fresh invitation afterwards.
Downloaded output is verified before the host exposes its download link.
The sample cancels on page exit and does not retain checkpoints across reloads.

Requires Web Crypto, WebSocket, File/Blob, AbortController and OPFS. The SDK
itself does not require OPFS. A host can supply another bounded streaming sink.

Run the sample's storage and cancellation regression tests with
`node --test examples/transfer-web/main.test.mjs`.
