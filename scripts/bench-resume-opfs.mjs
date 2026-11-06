// Storage-only comparison. Each 256 KiB write commits before the next begins.
// CD_OPFS_RUNS=7 CD_OPFS_SIZES_MIB=8,32 node scripts/bench-resume-opfs.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, statfs } from 'node:fs/promises';
import { homedir, cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from './harness.mjs';

const runs = Number(process.env.CD_OPFS_RUNS ?? 7);
const sizes = (process.env.CD_OPFS_SIZES_MIB ?? '8,32').split(',').map(Number);
assert.ok(Number.isSafeInteger(runs) && runs > 0);
assert.ok(sizes.length > 0 && sizes.every(n => Number.isSafeInteger(n) && n > 0 && n <= 256));
const profileRoot = process.env.CD_OPFS_PROFILE_ROOT ?? join(homedir(), '.cache');
await mkdir(profileRoot, { recursive: true });
const profile = await mkdtemp(join(profileRoot, 'cd-opfs-bench-'));
const report = { startedAt: new Date().toISOString(), cpu: cpus()[0]?.model, loadBefore: loadavg(), profile, profileFilesystem: await statfs(profile), runs, sizes, chunkBytes: 256 * 1024 };
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: await findChromium(), headless: true });
  report.chromium = context.browser()?.version();
  const page = await context.newPage();
  await page.route('http://127.0.0.1/cd-opfs-bench', route => route.fulfill({ contentType: 'text/html', body: '' }));
  await page.goto('http://127.0.0.1/cd-opfs-bench');
  report.trials = await page.evaluate(async ({ runs, sizes }) => {
    const workerSource = `
      let handle;
      onmessage = async ({ data }) => {
        try {
          if (data.type === 'open') {
            handle = await data.file.createSyncAccessHandle();
          } else if (data.type === 'write') {
            let written = 0;
            while (written < data.bytes.length) {
              const count = handle.write(data.bytes.subarray(written), { at: data.offset + written });
              if (count <= 0) throw new Error('OPFS short write');
              written += count;
            }
            handle.flush();
          } else if (data.type === 'close') {
            handle.close(); handle = undefined;
          } else throw new Error('Unknown storage operation');
          postMessage({ ok: true });
        } catch (error) { postMessage({ error: error.message }); }
      };
    `;
    const directory = await navigator.storage.getDirectory();
    const chunk = new Uint8Array(256 * 1024);
    for (let at = 0; at < chunk.length; at += 65536) crypto.getRandomValues(chunk.subarray(at, at + 65536));
    const workerURL = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    const rows = [];
    try {
      for (const mib of sizes) {
        const chunks = mib * 4;
        const expected = await crypto.subtle.digest('SHA-256', await new Blob(Array(chunks).fill(chunk)).arrayBuffer());
        for (let run = -1; run < runs; run++) {
          const modes = run % 2 ? ['sync-worker', 'reopen-stream'] : ['reopen-stream', 'sync-worker'];
          for (const mode of modes) {
            const name = `cd-opfs-bench-${crypto.randomUUID()}`;
            const file = await directory.getFileHandle(name, { create: true });
            let worker;
            const call = message => new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('OPFS worker timed out')), 30_000);
              worker.onmessage = event => { clearTimeout(timer); event.data.error ? reject(new Error(event.data.error)) : resolve(); };
              worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
              worker.postMessage(message);
            });
            try {
              const started = performance.now();
              if (mode === 'sync-worker') {
                worker = new Worker(workerURL);
                await call({ type: 'open', file });
              }
              const quarterTimes = [];
              let mark = performance.now();
              for (let offset = 0; offset < mib * 1024 * 1024; offset += chunk.length) {
                if (mode === 'reopen-stream') {
                  const writable = await file.createWritable({ keepExistingData: true });
                  await writable.seek(offset);
                  await writable.write(chunk);
                  await writable.close();
                } else {
                  // Structured clone includes one bounded chunk copy, as a main-thread receiver would need.
                  await call({ type: 'write', bytes: chunk, offset });
                }
                if ((offset + chunk.length) % (4 * 1024 * 1024) === 0) {
                  quarterTimes.push(performance.now() - mark);
                  mark = performance.now();
                }
              }
              if (worker) await call({ type: 'close' });
              const milliseconds = performance.now() - started;
              const staged = await file.getFile();
              if (staged.size !== mib * 1024 * 1024) throw new Error('OPFS file size mismatch');
              const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', await staged.arrayBuffer()));
              if (actual.some((byte, i) => byte !== new Uint8Array(expected)[i])) throw new Error('OPFS checksum mismatch');
              if (run >= 0) rows.push({ mode, run, mib, milliseconds, mibPerSecond: mib / (milliseconds / 1000), quarterMiB: 4, quarterTimes, verified: true });
            } finally {
              worker?.terminate();
              await directory.removeEntry(name);
            }
          }
        }
      }
      return rows;
    } finally { URL.revokeObjectURL(workerURL); }
  }, { runs, sizes });
  report.method = 'Chromium profile under reported path. Sequential 256 KiB writes. Baseline reopens keepExistingData writable, seeks, writes and closes every chunk. Candidate uses one dedicated-worker sync access handle, writes and flushes each chunk, and waits for its reply before next chunk. Includes worker startup, message clone and final close. SHA256, source setup and deletion outside timing. No encryption, hashing, checkpoint IDB or network in timed region. One warmup pair per size; measured pair order alternates.';
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.loadAfter = loadavg();
  console.log(JSON.stringify(report, null, 2));
}
