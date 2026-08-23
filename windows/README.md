# CD for Windows

Native WPF client for encrypted file transfers. The interface stays in the
Windows notification area when closed and does no polling while idle.

## Included

- Clerk browser sign-in using OAuth Authorization Code + PKCE and the existing
  Clerk user tenant.
- Nearby transfers over the local network through the existing encrypted `cdx`
  protocol. The receiver enters the short transfer code shown by the sender.
- Cloud transfers that encrypt on the sender before uploading and return a
  capability link. The storage service sees ciphertext, not file names or file
  contents.
- Event-driven background operation. `cdx.exe` runs only for an active
  transfer; closing the window hides CD to the tray.

## Clerk setup

Create a **public** OAuth application in the existing Clerk instance, enable
PKCE, allow `profile email offline_access`, and register this loopback redirect:

```text
http://127.0.0.1/callback
```

Then set `ClerkIssuer` and `ClerkClientId` in
`src/CD.Windows/appsettings.json`, or set `CD_CLERK_ISSUER` and
`CD_CLERK_CLIENT_ID`. The issuer is the Clerk Frontend API URL, such as
`https://example-name.clerk.accounts.dev`. No Clerk secret belongs in the app.

Guest mode remains available for transfers when Clerk is not configured.

## Build

Requirements: Windows 10/11, .NET 8 SDK, and Go 1.27 or newer.

```powershell
.\windows\build.ps1
```

The self-contained app is written to `windows\artifacts\win-x64\CD.exe` with
its `cdx.exe` transfer engine beside it. Use `-SelfContained $false` for a
smaller framework-dependent build.

The default encrypted storage origin is `https://getcroc.com`. Override it
with `StoreUrl` in `appsettings.json` or `CD_STORE_URL` when using a private
`cdx` storage service.

## Background behavior

Closing or minimizing the window hides it to the notification area. Right-click
the tray icon and choose **Exit CD** to stop it. Idle CD has no network loop,
polling timer, animation loop, or transfer subprocess; network and disk work
begin only after the user starts a transfer.
