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
