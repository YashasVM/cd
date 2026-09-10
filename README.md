<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/cd-Modernized_Fork_of_Sha-f4ed28?style=for-the-badge&labelColor=101010">
  <img alt="cd banner" src="https://img.shields.io/badge/cd-Modernized_Fork_of_Sha-164bff?style=for-the-badge&labelColor=f2ecd7">
</picture>

### A clearer, faster browser-to-browser file handoff app.

[![Status](https://img.shields.io/badge/status-active-008f5a?style=flat-square&labelColor=111111)](https://github.com/YashasVM/cd)
[![Origin](https://img.shields.io/badge/fork%20of-Sha-f04435?style=flat-square&labelColor=111111)](https://github.com/YashasVM/Sha)
[![Stack](https://img.shields.io/badge/stack-Vite%20%2B%20WebRTC-f4ed28?style=flat-square&labelColor=111111)](https://vite.dev)


[cd - Website](https://cd.yashasvm.workers.dev/) . [Original Sha Project](https://github.com/YashasVM/Sha) . [Source Code](https://github.com/YashasVM/cd)
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

## Links

| Link | Purpose |
|---|---|
| [cd Repository](https://github.com/YashasVM/cd) | Modernized fork and active codebase |
| [Original Sha Repository](https://github.com/YashasVM/Sha) | Source project this fork split from |
| [New main website](https://cd.yashasvm.workers.dev/) | Main Cd website, New UI, and Upgraded memes |
| [Vite](https://vite.dev) | Local dev server and production build tool |
| [PeerJS](https://peerjs.com/) | WebRTC signaling library |
| [QRCode](https://github.com/soldair/node-qrcode) | Sender QR generation |
| [html5-qrcode](https://github.com/mebjas/html5-qrcode) | Receiver camera QR scanning |
| [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) | Deployment target configured by `wrangler.jsonc` |

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

## Developer Setup

### Prerequisites

- Node.js 18 or newer
- npm 9 or newer
- Git
- A modern Chromium, Firefox, or Safari browser for WebRTC testing

### Clone

```bash
git clone https://github.com/YashasVM/cd.git
cd cd
```

### Install Dependencies

```bash
npm install
```

### Start Dev Server

```bash
npm run dev
```

Vite prints a local URL, usually `http://127.0.0.1:5173/`. Open it in two browser windows to test send and receive on one machine.

### Build Production Assets

```bash
npm run build
```

The production build is written to `dist/`.

### Run Dependency Audit

```bash
npm run audit
```

### Preview Production Build

```bash
npm run preview
```

### Deploy Notes

`wrangler.jsonc` points Cloudflare at `./dist`, so deploy after running `npm run build`. The repo is structured for static asset hosting; no server-side file storage process is required.

### Manual QA Checklist

- Send one small file.
- Send multiple files in one batch.
- Receive with manual code entry.
- Receive with a copied receive link.
- Receive by scanning the generated QR code.
- Try an invalid code and an unavailable sender.
- Test at least one large file to watch speed and backpressure behavior.

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


<div align="center">

**Made by [@yashas.vm](https://github.com/YashasVM)**

*A modernized split from Sha: clearer UI, cleaner code, faster handoffs.*

</div>
