# Android host example

`in.yash0.cd.sdk.sample` depends only on `:transfer`, never `:app`. It uses
platform Android views, a document picker, private source/staging files and an
Activity-owned executor. Build with:

```sh
android/gradlew -p android :sample:assembleDebug
```

Install `android/sample/build/outputs/apk/debug/sample-debug.apk` on two Android
29+ devices. Choose and send a file on one, copy the complete v2 invitation to
the other, then Receive. Accept or Reject in the host's dialog. Both sides show
the verified size and SHA-256; received files are stored privately in the
sample's files directory, with opaque names. The example does not import or
launch received files automatically.

Use the relay-origin field to select a v2 relay. The debug sample permits HTTP
for local development, such as `http://10.0.2.2:8787` on an emulator. Invitations
carry the sender's origin, so use an address reachable from both peers. Release
builds do not opt into cleartext traffic.

Try Cancel while waiting, during consent and while transferring. Turning off
the network stops the transfer; send a new invitation after reconnecting. For
expiry, use the public outgoing API's lifetimeMillis parameter. The automated
relay tests exercise these cases without needing Android UI automation.
The Activity cancels on destruction, including rotation. This sample does not
claim background delivery, resume, persistent sender retention or production
storage policy. See the integration guide for implementing host ownership.
