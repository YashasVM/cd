// CD_DIRECT_DRAIN_BASELINE=/path/to/direct-link-before.mjs node scripts/bench-direct-drain.mjs
// Actual CD record framing over local WebRTC. Encryption and disk I/O are excluded.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findChromium } from './harness.mjs';

const runs = Number(process.env.CD_DIRECT_DRAIN_RUNS ?? 7);
const mib = Number(process.env.CD_DIRECT_DRAIN_MIB ?? 32);
assert.ok(Number.isSafeInteger(runs) && runs > 0);
assert.ok(Number.isSafeInteger(mib) && mib > 0 && mib <= 128);
const sources = { current: await readFile(process.env.CD_DIRECT_DRAIN_MODULE ?? new URL('../src/direct-link.js', import.meta.url), 'utf8') };
if (process.env.CD_DIRECT_DRAIN_BASELINE) sources.before = await readFile(process.env.CD_DIRECT_DRAIN_BASELINE, 'utf8');
const browser = await chromium.launch({ executablePath: await findChromium(), headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://127.0.0.1/cd-direct-drain', route => route.fulfill({ contentType: 'text/html', body: '' }));
  await page.goto('http://127.0.0.1/cd-direct-drain');
  const trials = await page.evaluate(async ({ sources, runs, mib }) => {
    const modules = {};
    for (const [name, code] of Object.entries(sources)) {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try { modules[name] = await import(url); } finally { URL.revokeObjectURL(url); }
    }
    class LocalConnection extends RTCPeerConnection {
      constructor() { super({ iceServers: [] }); }
    }
    const record = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 251);
    record.set([0x43, 0x44, 1, 2]);
    new DataView(record.buffer).setUint32(8, record.length - 28);
    const recordCount = mib * 4;
    const expected = await crypto.subtle.digest('SHA-256', await new Blob(Array(recordCount).fill(record)).arrayBuffer());
    const results = [];
    const names = Object.keys(modules);
    for (let run = -1; run < runs; run++) {
      for (const name of run % 2 ? [...names].reverse() : names) {
        const received = [];
        let finish;
        const complete = new Promise(resolve => { finish = resolve; });
        let openSender, openReceiver;
        const ready = Promise.all([new Promise(resolve => { openSender = resolve; }), new Promise(resolve => { openReceiver = resolve; })]);
        let fail;
        const failed = new Promise((_, reject) => { fail = reject; });
        failed.catch(() => {});
        const common = { RTCPeerConnectionImpl: LocalConnection, onLost: fail };
        const sender = await modules[name].offerDirect({ ...common, onRecord() {}, onOpen: openSender });
        let receiver;
        try {
          receiver = await modules[name].answerDirect({
            ...common, offerSdp: sender.sdp, onSignal: value => sender.signal(value), onOpen: openReceiver,
            onRecord(value) { received.push(value); if (received.length === recordCount) finish(); }
          });
          const timer = setTimeout(() => { fail(new Error('Direct benchmark timed out')); sender.close(); receiver.close(); }, 60_000);
          try {
            await Promise.race([ready, failed]);
            const start = performance.now();
            for (let i = 0; i < recordCount; i++) await sender.send(record);
            await Promise.race([complete, failed]);
            const milliseconds = performance.now() - start;
            const digest = await crypto.subtle.digest('SHA-256', await new Blob(received).arrayBuffer());
            if (new Uint8Array(digest).some((byte, i) => byte !== new Uint8Array(expected)[i])) throw new Error(`${name} checksum mismatch`);
            if (run >= 0) results.push({ name, run, milliseconds, mibPerSecond: mib / (milliseconds / 1000), records: received.length });
          } finally { clearTimeout(timer); }
        } finally { sender.close(); receiver?.close(); }
      }
    }
    return results;
  }, { sources, runs, mib });
  console.log(JSON.stringify({ chromium: browser.version(), runs, mib, verified: true, method: 'Local host-candidate ordered WebRTC, actual CD record assembly and direct.send, 4 MiB native cap. Setup and SHA256 outside timing. No encryption, application ACKs, storage or internet route.', trials }, null, 2));
} finally {
  await browser.close();
}
