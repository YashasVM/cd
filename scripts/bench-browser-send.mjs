import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join, extname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { chromium } from 'playwright-core';
import { childExit, cliEnv, collect, findChromium, run, startWorker, stopChild } from './harness.mjs';

// Interleave the released sender and this checkout against the same receiver
// build and local relay. CD_BSEND_RTT is total added RTT across four proxy
// traversals. Time includes joining/consent; wireSeconds starts at CHUNK #1.
const root = process.cwd();
const baselineRef = process.env.CD_BSEND_BASE ?? '9732bbb';
const runs = Number(process.env.CD_BSEND_RUNS ?? 5);
const sizes = (process.env.CD_BSEND_MIB ?? '64,256').split(',').map(Number);
const rtts = (process.env.CD_BSEND_RTT ?? '0,50,150').split(',').map(Number);
const work = await mkdtemp(join(root, '.bench-bsend-'));
const results = [];
let worker;
let browser;
const servers = [];
const shaFile = async (path) => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
};
try {
  const baseline = join(work, 'baseline');
  await mkdir(baseline);
  const archive = join(work, 'baseline.tar');
  await run('git', ['archive', '--output', archive, baselineRef], { cwd: root });
  await run('tar', ['-x', '-f', archive, '-C', baseline]);
  await symlink(join(root, 'node_modules'), join(baseline, 'node_modules'));
  await run('npm', ['run', 'build'], { cwd: baseline });
  worker = await startWorker(work);
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] });
  const oldSite = await site(join(baseline, 'dist'), join(baseline, 'src'));
  const newSite = await site(join(root, 'dist'), join(root, 'src'));

  if (process.env.CD_BSEND_MICRO) {
    const context = await browser.newContext();
    const pages = {};
    for (const [variant, target] of [['old', oldSite], ['new', newSite]]) {
      pages[variant] = await context.newPage();
      await pages[variant].goto(target.url);
    }
    const micro = [];
    for (let pair = 0; pair < 5; pair += 1) {
      for (const variant of pair % 2 ? ['new', 'old'] : ['old', 'new']) {
        const samples = await pages[variant].evaluate(async () => {
          const { fileSource, rechunk, createZipBundle, crc32 } = await import('/source/zip-bundle.js');
          const { createSealer, KIND_CHUNK, SENDER_DIRECTION } = await import('/source/agent-protocol.js');
          const file = new File([new Uint8Array(64 * 1024 * 1024).fill(37)], 'micro.bin');
          const samples = [];
          for (const chunkBytes of [undefined, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
            const started = performance.now();
            let bytes = 0;
            for await (const chunk of rechunk(fileSource(file, { chunkBytes }).stream(), 256 * 1024)) bytes += chunk.length;
            samples.push({ task: 'file', chunkBytes: chunkBytes ?? 'default', bytes, ms: performance.now() - started });
          }
          const started = performance.now();
          let bytes = 0;
          for await (const chunk of rechunk(createZipBundle([file]).stream(), 256 * 1024)) bytes += chunk.length;
          samples.push({ task: 'zip', bytes, ms: performance.now() - started });
          const input = new Uint8Array(await file.arrayBuffer());
          const crcStart = performance.now();
          const crc = crc32(input);
          samples.push({ task: 'crc32', crc, ms: performance.now() - crcStart });
          for (const chunkBytes of [64 * 1024, 256 * 1024, 512 * 1024]) {
            const invitation = { id: new Uint8Array(16), key: crypto.getRandomValues(new Uint8Array(32)) };
            const sealer = await createSealer(invitation, SENDER_DIRECTION);
            const started = performance.now();
            for (let offset = 0; offset < input.length; offset += chunkBytes) await sealer.seal(KIND_CHUNK, input.subarray(offset, offset + chunkBytes));
            samples.push({ task: 'seal', chunkBytes, ms: performance.now() - started });
          }
          return samples;
        });
        for (const sample of samples) {
          if (sample.task === 'crc32') assert.equal(sample.crc, 2810855534);
          if (sample.task === 'file') assert.equal(sample.bytes, 64 * 1024 * 1024);
          if (sample.task === 'zip') assert.equal(sample.bytes, 64 * 1024 * 1024 + 132);
        }
        micro.push(...samples.map((sample) => ({ variant, pair, ...sample })));
      }
    }
    const report = { baselineRef, micro };
    if (process.env.CD_BSEND_OUT) await writeFile(process.env.CD_BSEND_OUT, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    await context.close();
  } else {
    for (const mib of sizes) {
      const path = join(work, `payload-${mib}.bin`);
      const output = await open(path, 'w');
      const block = Buffer.alloc(1024 * 1024);
      for (let index = 0; index < block.length; index += 1) block[index] = (index * 31 + 7) % 256;
      for (let index = 0; index < mib; index += 1) await output.write(block);
      await output.close();
      const expected = await shaFile(path);
      for (const rtt of rtts) {
        oldSite.delayMs = newSite.delayMs = rtt / 4;
        for (let pair = 0; pair < runs; pair += 1) {
          for (const variant of pair % 2 ? ['new', 'old'] : ['old', 'new']) {
            const sample = await transfer(variant === 'old' ? oldSite : newSite, oldSite, path, expected, mib);
            const result = { variant, mib, rtt, pair, ...sample };
            results.push(result);
            console.log(JSON.stringify(result));
            if (process.env.CD_BSEND_OUT) {
              await writeFile(process.env.CD_BSEND_OUT, JSON.stringify({ baselineRef, runs, sizes, rtts, results }, null, 2) + '\n');
            }
          }
        }
      }
    }
    if (!process.env.CD_BSEND_SKIP_CLI) {
      oldSite.delayMs = newSite.delayMs = 0;
      const path = join(work, `payload-${sizes[0]}.bin`);
      const expected = await shaFile(path);
      const context = await browser.newContext();
      const { page, code } = await sender(context, newSite, path);
      const out = join(work, 'cli-out');
      await mkdir(out);
      const cli = spawn(join(root, 'bin/cdx'), ['receive', code, '--out', out, '--json'], {
        env: cliEnv(worker), stdio: ['ignore', 'pipe', 'pipe']
      });
      const stdout = collect(cli.stdout);
      const stderr = collect(cli.stderr);
      assert.equal(await childExit(cli, 120_000), 0, await stderr);
      assert.equal(await shaFile(join(out, `payload-${sizes[0]}.bin`)), expected);
      await page.locator('#sender-complete:not(.hidden)').waitFor();
      results.push({ compatibility: 'new browser -> baseline CLI', mib: sizes[0], sha256: expected, cli: JSON.parse(await stdout) });
      await context.close();
    }
    const report = { baselineRef, runs, sizes, rtts, results };
    await writeFile(process.env.CD_BSEND_OUT ?? join(work, '..', 'browser-send-results.json'), JSON.stringify(report, null, 2) + '\n');
  }
} finally {
  await browser?.close();
  for (const server of servers) await server.stop();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}

async function sender(context, target, path) {
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(target.url);
  await page.locator('.workbench:not([inert])').waitFor();
  await page.locator('#file-input').setInputFiles(path);
  await page.locator('#sender-code-section:not(.hidden)').waitFor();
  const code = (await page.locator('#share-code').textContent()).trim();
  return { page, code };
}

async function transfer(sendSite, receiveSite, path, expected, mib) {
  let profiler;
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    await context.addInitScript(() => {
      delete window.showSaveFilePicker;
      window.__wire = { first: null, complete: null, offer: null, accepted: null, maxBuffered: 0, chunks: 0 };
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            if (data instanceof ArrayBuffer) {
              const kind = new Uint8Array(data)[3];
              if (kind === 6) window.__wire.complete = performance.now();
              if (kind === 4) window.__wire.accepted = performance.now();
            }
          });
        }
        send(data) {
          if (data instanceof Uint8Array && data[3] === 1) window.__wire.offer = performance.now();
          if (data instanceof Uint8Array && data[3] === 2) {
            window.__wire.first ??= performance.now();
            window.__wire.chunks += 1;
          }
          super.send(data);
          window.__wire.maxBuffered = Math.max(window.__wire.maxBuffered, this.bufferedAmount);
        }
      };
    });
    const { page: sendPage, code } = await sender(context, sendSite, path);
    const receivePage = await context.newPage();
    receivePage.setDefaultTimeout(120_000);
    await receivePage.goto(receiveSite.url);
    await receivePage.locator('.workbench:not([inert])').waitFor();
    await receivePage.locator('#receive-mode-btn').click();
    if (process.env.CD_BSEND_PROFILE) profiler = await profile(context, { sender: sendPage, receiver: receivePage });
    const downloaded = receivePage.waitForEvent('download', { timeout: 120_000 });
    const started = performance.now();
    await receivePage.locator('#code-input').fill(code);
    const download = await downloaded;
    const seconds = (performance.now() - started) / 1000;
    const saved = join(work, 'download.bin');
    await download.saveAs(saved);
    assert.equal((await stat(saved)).size, mib * 1024 * 1024);
    assert.equal(await shaFile(saved), expected);
    await sendPage.locator('#sender-complete:not(.hidden)').waitFor();
    const wire = await sendPage.evaluate(() => window.__wire);
    const wireSeconds = (wire.complete - wire.first) / 1000;
    const diagnostics = profiler ? { profile: await profiler.stop() } : {};
    return { seconds, mibPerSecond: mib / seconds, wireSeconds, wireMiBPerSecond: mib / wireSeconds, maxBuffered: wire.maxBuffered, chunks: wire.chunks, acceptRTT: wire.accepted - wire.offer, sha256: expected, ...diagnostics };
  } finally {
    await profiler?.stop();
    await context.close();
  }
}

async function site(dist, source) {
  const state = { delayMs: 0 };
  const sockets = new Set();
  const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  let connections = 0;
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const upstream = request(worker.publicBase + req.url, { method: req.method, headers: { ...req.headers, host: new URL(worker.publicBase).host, 'cf-connecting-ip': `127.1.${Math.floor(connections / 250) % 250}.${connections % 250 + 1}` } }, (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on('error', (error) => { res.writeHead(502); res.end(error.message); });
      req.pipe(upstream);
      return;
    }
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      let path = pathname.startsWith('/source/') ? join(source, pathname.slice(8)) : join(dist, pathname);
      try { if (!(await stat(path)).isFile()) path = join(dist, 'index.html'); }
      catch { path = join(dist, 'index.html'); }
      const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json' }[extname(path)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(await readFile(path));
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  server.on('upgrade', (req, socket, head) => {
    const address = `127.2.${Math.floor(connections / 250) % 250}.${connections++ % 250 + 1}`;
    wsServer.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(worker.publicBase.replace(/^http/, 'ws') + req.url, { perMessageDeflate: false, headers: { 'cf-connecting-ip': address } });
      sockets.add(client); sockets.add(upstream);
      const timers = new Set();
      const pending = [];
      const forward = (to, data, isBinary) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
        }, state.delayMs);
        timers.add(timer);
      };
      client.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.CONNECTING) pending.push([data, isBinary]);
        else forward(upstream, data, isBinary);
      });
      upstream.on('open', () => { for (const [data, binary] of pending.splice(0)) forward(upstream, data, binary); });
      upstream.on('message', (data, binary) => forward(client, data, binary));
      const close = (other, code, reason) => {
        // Close follows the last delayed message, including COMPLETE.
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (other.readyState === WebSocket.OPEN) other.close(code === 1005 || code === 1006 ? 1000 : code, reason);
        }, state.delayMs + 1);
        timers.add(timer);
      };
      client.on('close', (code, reason) => { sockets.delete(client); close(upstream, code, reason); });
      upstream.on('close', (code, reason) => { sockets.delete(upstream); close(client, code, reason); });
      client.on('error', () => upstream.terminate());
      upstream.on('error', () => client.terminate());
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.stop = async () => {
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    wsServer.close();
  };
  servers.push(state);
  return state;
}


// Optional diagnostics for a slow paired run, excluded from normal timing.
async function profile(context, pages) {
  const sessions = {};
  const initial = {};
  const peaks = {};
  const latest = {};
  for (const [name, page] of Object.entries(pages)) {
    const session = await context.newCDPSession(page);
    await session.send('Performance.enable');
    sessions[name] = session;
    initial[name] = Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
    peaks[name] = { heap: 0, backing: 0 };
  }
  let pending = Promise.resolve();
  let stopped;
  const sample = () => Promise.all(Object.entries(sessions).map(async ([name, session]) => {
    const [heap, metrics] = await Promise.all([session.send('Runtime.getHeapUsage'), session.send('Performance.getMetrics')]);
    peaks[name].heap = Math.max(peaks[name].heap, heap.usedSize);
    peaks[name].backing = Math.max(peaks[name].backing, heap.backingStorageSize ?? 0);
    latest[name] = Object.fromEntries(metrics.metrics.map(({ name, value }) => [name, value]));
  }));
  const timer = setInterval(() => { pending = pending.then(sample); }, 250);
  return {
    stop() {
      stopped ??= (async () => {
        clearInterval(timer);
        await pending;
        await sample();
        return Object.fromEntries(Object.keys(pages).map((name) => [name, {
          peakHeapBytes: peaks[name].heap,
          peakBackingBytes: peaks[name].backing,
          taskSeconds: latest[name].TaskDuration - initial[name].TaskDuration,
          scriptSeconds: latest[name].ScriptDuration - initial[name].ScriptDuration
        }]));
      })();
      return stopped;
    }
  };
}
