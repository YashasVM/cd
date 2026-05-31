<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/cd-Modernized_Fork_of_Sha-f4ed28?style=for-the-badge&labelColor=101010">
  <img alt="cd banner" src="https://img.shields.io/badge/cd-Modernized_Fork_of_Sha-164bff?style=for-the-badge&labelColor=f2ecd7">
</picture>

### A clearer, faster browser-to-browser file handoff app.

[![Status](https://img.shields.io/badge/status-active-008f5a?style=flat-square&labelColor=111111)](https://github.com/YashasVM/cd)
[![Origin](https://img.shields.io/badge/fork%20of-Sha-f04435?style=flat-square&labelColor=111111)](https://github.com/YashasVM/Sha)
[![Stack](https://img.shields.io/badge/stack-Vite%20%2B%20WebRTC-f4ed28?style=flat-square&labelColor=111111)](https://vite.dev)

**No login** . **No server-side file storage** . **Multi-file transfer** . **QR ready**

[Source Code](https://github.com/YashasVM/cd) . [Original Sha Project](https://github.com/YashasVM/Sha) . [Report an Issue](https://github.com/YashasVM/cd/issues)

---

</div>

> [!IMPORTANT]
> This is a fork of **Sha**, modified and modernized with a clearer UI, cleaner codebase, and faster transfer behavior. It exists as a separate project to maintain a clean separation from the clunkiness of the old project while preserving the original idea.

## What is cd?

cd is a direct browser-to-browser file sharing app. Pick files, get a friendly receive code, share the code or QR link, and keep both browser tabs open while the transfer runs.

```text
Sender Browser -> WebRTC Data Channel -> Receiver Browser
       |                 ^
       |                 |
       +-- PeerJS signaling for connection setup
```

---

## Features

### Transfer Flow

| Feature | Details |
|---|---|
| **Direct P2P Transfer** | Files transfer between browsers over WebRTC data channels |
| **No Server Storage** | The hosted app does not intentionally store transferred file contents |
| **Multi-File Batches** | Send one file or many files in a single session |
| **Friendly Codes** | Human-readable receive words with compact joining |
| **Share Links** | Receiver links support `?receive=code` deep linking |
| **QR Handoff** | Sender generates a QR code for quick joining |

### Modernization Goals

| Area | What Changed |
|---|---|
| **UI** | Rebuilt into a sharper, clearer brutalist workbench |
| **Codebase** | Moved from loose static scripts into a Vite ES module app |
| **Speed** | Uses binary chunks, file streams, and data-channel backpressure |
| **Safety** | Avoids CDN script injection and keeps file handling in browser APIs |
| **Deployment** | Builds to `dist/` for cleaner Cloudflare static asset hosting |

---

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Run Locally

```bash
npm run dev
```

Open the local Vite URL in two browser windows or on two devices.

### 3. Send

1. Choose or drop one or more files.
2. Share the generated code, copy the join link, or show the QR code.
3. Keep the sender tab open until the receiver connects.

### 4. Receive

1. Switch to **Receive**, open a receive link, or scan the QR code.
2. Connect with the code.
3. Save streamed files when prompted, or let the browser download Blob fallbacks.

---

## Architecture

```text
+-------------------+        PeerJS signaling        +-------------------+
|   Sender Browser  | <----------------------------> | Receiver Browser |
|                   |                                |                  |
| File picker/drop  |                                | Code/QR scanner  |
| Manifest builder  |                                | Manifest reader  |
| Stream reader     |                                | Save/download    |
+---------+---------+                                +---------+--------+
          |                                                    ^
          |              WebRTC data channel                   |
          +----------------------------------------------------+
                         Raw binary chunks
```

### Runtime Defaults

| Parameter | Value |
|---|---|
| App Runtime | Vite vanilla JavaScript with ES modules |
| Signaling | `peerjs@1.5.5` |
| QR Generation | `qrcode@1.5.4` |
| QR Scanning | `html5-qrcode@2.3.8` |
| Hosting Target | Cloudflare static assets from `dist/` |
| Buffer Guard | Data channel backpressure before large buffered queues build up |

---

## Repository Layout

```text
/
|-- index.html              App shell and accessible transfer views
|-- src/
|   |-- main.js             Sender, receiver, WebRTC, QR, and transfer logic
|   `-- style.css           Brutalist responsive interface
|-- favicon.svg             App icon
|-- package.json            Scripts and dependencies
|-- package-lock.json       Locked dependency graph
|-- wrangler.jsonc          Cloudflare static asset config
`-- README.md               Project documentation
```

---

## Build and Checks

```bash
npm run build
npm run audit
```

Cloudflare serves the production build from `dist/`, as configured in `wrangler.jsonc`.

---

## Safety Notes

- File contents are sent over WebRTC data channels between connected browsers.
- The hosted app serves static assets and does not intentionally store transferred files.
- PeerJS signaling helps establish the connection, but it is not a file storage layer.
- Share codes are temporary secrets. Send them only to the intended receiver.
- The sender should keep the tab open until the transfer completes.
- Browser support, NAT behavior, VPNs, and local network policies can affect peer connectivity.

---

## License

MIT

---

<div align="center">

**Made by [@yashas.vm](https://github.com/YashasVM)**

*A modernized split from Sha: clearer UI, cleaner code, faster handoffs.*

</div>
