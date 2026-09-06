# CD Web

React/Vite browser client for the CD cloud send workbench. Clerk handles identity; the client uses the versioned `/v1` control-plane endpoints for recipient lookup and enrolled-device data.

Set `VITE_CLERK_PUBLISHABLE_KEY` for Clerk and optionally `VITE_CONTROL_PLANE_URL` when the API is hosted separately. Keep Clerk secret keys server-side.

```powershell
npm install
npm run dev
```

Production check:

```powershell
npm run check
```

## CD Android

The Android app combines two transfer modes in one dark UI:

- **Local** — nearby Android-to-Android file transfer without the internet.
- **Cloud** — the production CD web flow with existing Clerk login, guest mode, username/email recipients, and share links.

Build the debug APK:

```powershell
cd android
.\gradlew.bat :app:assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Install CD on both devices for local transfers; received files are saved in `Downloads/CD`.
