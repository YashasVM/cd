// Build croc's tagged web client using its documented web/README.md workflow.
// Synthetic local-only transfers; no public relays or stored mode.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, open, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {availablePort, captureOutput, childExit, findChromium, stopChild} from './harness.mjs';

const executable = resolve(process.env.CD_BENCH_CROC || '/tmp/croc-bench-latest/croc');
const webExecutable = resolve(process.env.CD_CROC_WEB_BIN || '/tmp/croc-browser-bench-web');
const source = resolve(process.env.CD_CROC_SOURCE_DIR || '/tmp/croc-browser-benchmark-source');
const output = resolve(process.env.CD_CROC_BROWSER_OUTPUT || '/tmp/croc-browser.json');
const runs = Number(process.env.CD_CROC_BROWSER_RUNS || 1), mib = Number(process.env.CD_CROC_BROWSER_MIB || 64);
const directions = (process.env.CD_CROC_BROWSER_ONLY || 'browser-browser,browser-cli,cli-browser').split(',');
assert.ok(Number.isInteger(runs) && runs > 0 && Number.isInteger(mib) && mib > 0);
assert.ok(directions.every(value => ['browser-browser', 'browser-cli', 'cli-browser'].includes(value)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const work = await mkdtemp('/dev/shm/croc-browser-'), children = new Set();
const ports = [];
while (ports.length < 5) { const port = await availablePort(); if (!ports.includes(port)) ports.push(port); }
const webPort = await availablePort(), publicBase = `http://127.0.0.1:${webPort}`;
const relay = `127.0.0.1:${ports[0]}`, password = randomBytes(16).toString('hex');
const report = {version: 1, startedAt: new Date().toISOString(), runs, mib, rows: [],
  method: 'Official croc browser UI and tagged croc-web server, private loopback relay, default browser compression policy. Pages preload outside timing; readiness starts at file selection or CLI launch. Receiver timing starts at code entry or CLI launch and includes automatic consent and download save. File/directory fsync added for every output; SHA-256 checked outside timing. RAM output, warm input cache. No direct browser transport or public internet claim.'};
function launch(command, args, env = {}) {
  const child = spawn(command, args, {env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  children.add(child); return {child, out: captureOutput(child)};
}
function senderReady(process) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); process.child.stderr.off('data', check); process.child.off('exit', exited); };
    const check = () => { if (/Code is:|On the other computer/.test(process.out.stderr)) { cleanup(); resolve(); } };
    const exited = code => { cleanup(); reject(new Error(`CLI sender exited ${code}: ${process.out.stderr}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('CLI sender readiness timed out')); }, 30000);
    process.child.stderr.on('data', check); process.child.once('exit', exited); check();
  });
}
let browser;
try {
  report.outputFilesystem = execFileSync('stat', ['-f', '-c', '%T', work], {encoding: 'utf8'}).trim();
  assert.equal(report.outputFilesystem, 'tmpfs', 'RAM-output comparison requires tmpfs');
  report.sourceCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  report.sourceDirty = execFileSync('git', ['-C', source, 'status', '--porcelain'], {encoding: 'utf8'}).trim();
  report.crocVersion = execFileSync(executable, ['--version'], {encoding: 'utf8'}).trim();
  report.binaries = {croc: hash(await readFile(executable)), web: hash(await readFile(webExecutable))};
  const relayProcess = launch(executable, ['--pass', password, 'relay', '--host', '127.0.0.1', '--ports', ports.join(','), '--source-join-limit', '100000', '--room-join-limit', '100000']);
  const web = launch(webExecutable, ['--pass', password, '--relays', '127.0.0.1', '--ports', ports.join(','), `127.0.0.1:${webPort}`], {UMAMI_URL: '', UMAMI_WEBSITE_ID: ''});
  const deadline = performance.now() + 30000;
  while (true) {
    assert.equal(web.child.exitCode, null, web.out.stderr);
    assert.equal(relayProcess.child.exitCode, null, relayProcess.out.stderr);
    try { if ((await fetch(publicBase + '/healthz')).ok) break; } catch {}
    assert.ok(performance.now() < deadline, 'croc-web did not become healthy');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const payload = randomBytes(mib * 1048576), input = join(work, 'payload.bin');
  await writeFile(input, payload); const expected = hash(payload);
  browser = await chromium.launch({executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage']});
  report.chromium = browser.version();
  const flags = ['--relay', relay, '--relay6', '', '--pass', password, '--yes', '--overwrite', '--ignore-stdin', '--disable-clipboard'];
  for (let run = 0; run < runs; run++) for (const direction of directions) {
    const contexts = [], active = [], row = {direction, route: 'relay', run, bytes: payload.length, ok: false};
    let sender, receiver, senderPage, receiverPage;
    const page = async () => {
      const context = await browser.newContext({acceptDownloads: true}); contexts.push(context);
      const page = await context.newPage(); page.setDefaultTimeout(120000);
      await page.goto(publicBase);
      await page.locator('details.settings > summary').click();
      await page.getByLabel('WebSocket gateway').fill('/ws');
      await page.getByRole('textbox', {name: 'Relay password', exact: true}).fill(password);
      assert.equal(await page.getByLabel('CLI relay addresses').inputValue(), relay);
      await page.locator('details.settings > summary').click();
      return page;
    };
    try {
      if (direction.startsWith('browser')) senderPage = await page();
      if (direction.endsWith('browser')) receiverPage = await page();
      const dir = join(work, `${run}-${direction}`); await mkdir(dir);
      const target = join(dir, 'payload.bin'); let code;
      const started = performance.now();
      if (senderPage) {
        const panel = senderPage.locator('.send-panel');
        await panel.locator('input[type="file"]').setInputFiles(input);
        await panel.getByRole('button', {name: 'Send file', exact: true}).click();
        await panel.getByLabel('Croc code').waitFor();
        code = (await panel.getByLabel('Croc code').textContent()).trim();
        assert.match(code, /^[a-z0-9]+(?:-[a-z0-9]+){2,5}$/);
      } else {
        code = randomBytes(8).toString('hex') + '-browser-benchmark';
        sender = launch(executable, [...flags, 'send', '--no-local', input], {CROC_SECRET: code, CROC_CONFIG_DIR: join(work, `config-${run}-${direction}`)});
        active.push(sender.child);
        await senderReady(sender);
      }
      const receiving = performance.now(); row.readyMs = receiving - started;
      if (receiverPage) {
        const downloadPromise = receiverPage.waitForEvent('download', {timeout: 120000});
        downloadPromise.catch(() => {});
        const panel = receiverPage.locator('.receive-panel');
        await panel.getByLabel('Croc code').fill(code); await panel.getByLabel('Croc code').press('Enter');
        await panel.getByText('Incoming transfer', {exact: true}).waitFor();
        const fallback = panel.getByRole('button', {name: 'Download', exact: true});
        if (await fallback.isVisible()) await fallback.click();
        else await panel.getByRole('button', {name: 'Accept files', exact: true}).click();
        const download = await downloadPromise; row.downloadEventMs = performance.now() - receiving;
        assert.equal(download.suggestedFilename(), 'payload.bin');
        await download.saveAs(target);
        await panel.getByText('All files received and verified', {exact: false}).waitFor();
      } else {
        receiver = launch(executable, [...flags, '--out', dir], {CROC_SECRET: code, CROC_CONFIG_DIR: join(work, `config-${run}-${direction}`)});
        active.push(receiver.child); assert.equal(await childExit(receiver.child, 120000), 0, receiver.out.stderr);
      }
      row.receiverMs = performance.now() - receiving;
      for (const path of [target, dir]) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
      row.durableMs = performance.now() - receiving; row.totalMs = performance.now() - started;
      if (sender) assert.equal(await childExit(sender.child, 120000), 0, sender.out.stderr);
      else await senderPage.locator('.send-panel').getByText('All files arrived safely', {exact: false}).waitFor();
      assert.equal(hash(await readFile(target)), expected); row.sha256 = expected; row.ok = true;
    } catch (error) {
      row.error = error.stack;
      row.diagnostics = {sender: sender?.out.stderr, receiver: receiver?.out.stderr,
        senderPage: await senderPage?.locator('body').innerText().catch(() => ''), receiverPage: await receiverPage?.locator('body').innerText().catch(() => '')};
    } finally {
      for (const child of active) { await stopChild(child); children.delete(child); }
      for (const context of contexts) await context.close();
    }
    report.rows.push(row); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.error(`${direction} #${run + 1}: ${row.ok ? row.durableMs.toFixed(1) + ' ms' : row.error}`);
  }
} catch (error) { report.error = error.stack; }
finally {
  for (const child of children) await stopChild(child);
  await browser?.close(); await rm(work, {recursive: true, force: true});
  report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
if (report.error || report.rows.some(row => !row.ok)) process.exitCode = 1;
console.log(JSON.stringify({output, passed: report.rows.filter(row => row.ok).length, failed: report.rows.filter(row => !row.ok).length, error: report.error}));
