# Set up Firebase wake-up for CD

This prepares a new Firebase project for optional Android wake-up. CD still receives through LAN, native WebRTC and the encrypted relay. Firebase carries a small wake hint containing a pair ID and time. It carries no file contents, filenames or transfer keys.

Wake-up applies only while **receiving** and **Trusted wake-up notifications** are enabled. Stop stays off until you enable receiving again. A force-stopped app must be opened again.

## Create and configure the project

From the repository root, run:

```sh
./scripts/setup-firebase.sh
```

The wizard opens the required Google pages and walks through these steps:

1. Create a Firebase project named **CD** and choose its unique project ID. Analytics and AI assistance are optional and unused by CD.
2. Register an Android app with the exact package name `in.yash0.cd`. Download `google-services.json`. FCM does not need a signing SHA fingerprint.
3. Enable **Firebase Cloud Messaging API** for the project.
4. Create a dedicated `cd-wake` service account with **Firebase Cloud Messaging API Admin**, `roles/firebasecloudmessaging.admin`. Download its JSON key through the service account's Keys tab.
5. Enter the paths to the two downloaded files. The wizard checks their project IDs, Android package and RSA key, then prepares the local files below. It never asks you to paste the key into chat.

The registration and Android configuration steps follow [Firebase's Android setup guide](https://firebase.google.com/docs/android/setup). The server identity uses the [FCM API role](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasecloudmessaging).

| Local file | Purpose |
| --- | --- |
| `android/app/google-services.json` | Non-secret Firebase app identifiers used by the optional Android build. |
| `.firebase/service-account.json` | Private server signing key. Directory mode 0700, file mode 0600. |
| `.firebase/worker-secrets.json` | Private Wrangler secret bundle containing `FCM_SERVICE_ACCOUNT_JSON`. |
| `.firebase/setup.env` | The project ID for rerunning the wizard. |

These paths are ignored by Git. The server key is never included in the Android build. The wizard does not upload credentials or deploy a Worker.

Check the prepared files again with:

```sh
node scripts/firebase-config.mjs check
```

## Build the configured Android app

Use JDK 17 and an installed Android SDK. For the S24 Ultra:

```sh
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug -PcdFcm=true -PcdAbi=arm64-v8a
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The default build omits Firebase. The optional build requires the real `app/google-services.json`; missing configuration produces a setup error. The previously built preview APK has no Firebase project configured and must be rebuilt after setup.

Open CD, allow notifications, enable receiving, and opt into **Trusted wake-up notifications**. Pair the laptop normally. The app registers its Firebase installation ID only through an authenticated paired relay. Sender and receiver admission credentials have separate permissions; the sender cannot read or replace the phone's push target.

## Configure the test Worker

Use the existing isolated `test` environment first. These commands change remote resources, so run them only when you are ready to activate the prepared integration.

First build and deploy the implementation to the test Worker:

```sh
npm run build
npx wrangler deploy --env test
```

Stage the secret bundle without activating it:

```sh
npx wrangler versions secret bulk .firebase/worker-secrets.json --env test
```

Review the version reported by Wrangler. Activate the intended test version separately using the [Workers versions workflow](https://developers.cloudflare.com/workers/configuration/secrets/#secrets-and-versions). A plain `wrangler secret put` or `secret bulk` immediately deploys a version, so this guide uses `versions secret bulk`.

The Worker derives the Firebase project from its service-account JSON. Optional `FCM_PROJECT_ID`, if set, must match that project. Production and test Worker credentials are configured separately. Do not run a bare deployment from this development checkout.

Build the matching CLI with `go build -o ./bin/cdx-dev ./cmd/cdx`. Pair against `cd-test.yash0.in` by setting `CD_RELAY_URL=wss://cd-test.yash0.in/ws/v1` and `CD_PUBLIC_URL=https://cd-test.yash0.in`. Existing pairings retain their original relay URL; use a fresh test pairing for that environment.

## Verify wake-up on the S24 Ultra

1. Install the configured APK and pair against the configured test Worker.
2. Enable notifications, receiving and Trusted wake-up notifications. Keep the phone online until it has registered.
3. Close the activity and send a file with `./bin/cdx-dev send --to phone <file>`. A slow connection triggers an authenticated wake request automatically.
4. Test idle and screen-off delivery, then Stop. A new send must not turn receiving back on.
5. Revoke the laptop. Later wake hints from that pair must be ignored.

Use a physical device with Google Play services for the delivery check. Tests without a configured project exercise protocol validation and a mock Google transport, rather than claiming an actual FCM delivery.

High-priority messages are a best-effort wake hint. Android can downgrade their priority or reject a background foreground-service start. CD falls back to a notification the user can tap. Firebase documents these limits in its [Android message-priority guidance](https://firebase.google.com/docs/cloud-messaging/android/message-priority).

## Rotate or remove the key

Create a replacement JSON key for the same dedicated service account, rerun the wizard, stage the updated Worker secret bundle, and activate the intended version. After verifying delivery, revoke the old key in Google IAM. Removing local files alone does not revoke an uploaded Worker secret or a Google key.

To disable wake-up on the phone, turn off Trusted wake-up notifications. LAN and relay transfers continue while receiving remains enabled. Stop disables receiving as well.
