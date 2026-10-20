import test from 'node:test';
import assert from 'node:assert/strict';
import { median, summarize, cases, trial } from './bench-croc-matrix.mjs';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real child-process lifecycles, but synthetic local file copies only: no
// network, relays, installed binaries, or benchmark results are involved.
async function fakeTrial(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cd-matrix-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'source.bin'), output = join(root, 'out');
  const executable = join(root, 'fake-cli');
  const data = Buffer.from('synthetic benchmark regression fixture');
  await writeFile(input, data);
  await mkdir(output);
  const config = { input, output, senderDelayMs: 0, senderReport: true, receiverReport: true, ...settings };
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
const sending = args.includes('send');
const target = path.join(config.output, 'payload.bin');
function report(endpoint) {
  const value = config[endpoint + 'Report'];
  if (value) console.error(JSON.stringify(value === true ? {transport:'relay',relayBytes:100,directBytes:0} : value));
}
if (sending) {
  if (config.crocTransport === 'relay' && !(args.includes('--no-local') && args[args.indexOf('--transport') + 1] === 'relay')) {
    console.error('forced croc relay requires --no-local --transport relay'); process.exit(2);
  }
  if (config.crocTransport === 'auto' && (args.includes('--no-local') || args.includes('--transport'))) {
    console.error('auto transport must retain croc defaults'); process.exit(2);
  }
  console.log(config.tool?.startsWith('croc') ? 'Code is:' : '12345');
  const poll = setInterval(() => {
    if (!fs.existsSync(target)) return;
    clearInterval(poll);
    setTimeout(() => report('sender'), config.senderDelayMs);
  }, 2);
} else {
  fs.copyFileSync(config.input, target);
  report('receiver');
  if (config.receiverExitDelayMs) setTimeout(() => {}, config.receiverExitDelayMs);
}
`);
  await chmod(executable, 0o700);
  return trial({ tool: settings.tool || 'cd', route: settings.route || 'relay', input, output,
    state: join(root, 'state'), executable, croc: executable,
    worker: { relayBase: 'ws://127.0.0.1:1/ws/v1', publicBase: 'http://127.0.0.1:1' },
    relay: '127.0.0.1:1', timeout: 3000, expected: createHash('sha256').update(data).digest('hex') });
}

test('total completion waits for a delayed sender after receiver durability', async t => {
  const result = await fakeTrial(t, { senderDelayMs: 160 });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.totalMs >= result.readyMs + result.durableMs + 100, JSON.stringify(result));
  assert.ok(result.senderExitMs >= result.readyMs + result.durableMs + 100);
  assert.equal(result.totalMs, Math.max(result.readyMs + result.durableMs, result.senderExitMs));
});
test('total completion retains receiver durability when sender closes first', async t => {
  const result = await fakeTrial(t, { receiverExitDelayMs: 160 });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.totalMs >= result.senderExitMs + 100, JSON.stringify(result));
  assert.ok(Math.abs(result.totalMs - result.readyMs - result.durableMs) < 1e-6);
  assert.deepEqual(result.reports.map(report => report.endpoint), ['sender', 'receiver']);
});
test('CD route evidence cannot pass when both endpoint reports are missing', async t => {
  const result = await fakeTrial(t, { senderReport: false, receiverReport: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /sender.*transport.*evidence/i);
});
test('CD route evidence must come from each endpoint, including auto mode', async t => {
  const result = await fakeTrial(t, { route: 'auto', receiverReport: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /receiver.*transport.*evidence/i);
});
test('CD forced relay rejects direct payload and invalid counters', async t => {
  for (const senderReport of [
    { transport: 'direct', relayBytes: 100, directBytes: 1 },
    { transport: 'relay', relayBytes: -1, directBytes: 0 },
    { transport: 'relay', relayBytes: '100', directBytes: 0 },
    { transport: 'relay', relayBytes: 0, directBytes: 0 },
    { transport: 'relay', relayBytes: 100, directBytes: 1 },
    { transport: 'unknown', relayBytes: 100, directBytes: 0 },
  ]) {
    const result = await fakeTrial(t, { senderReport });
    assert.equal(result.ok, false, JSON.stringify(senderReport));
  }
});
test('CD auto accepts evidenced direct records without calling them relay-only', async t => {
  const direct = { transport: 'direct', relayBytes: 100, directBytes: 100, directProtocol: 'webrtc' };
  const result = await fakeTrial(t, { route: 'auto', senderReport: direct, receiverReport: direct });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.routeObserved, 'direct');
});
test('croc relay disables both local discovery and Tailcat data transport', async t => {
  const result = await fakeTrial(t, { tool: 'croc', crocTransport: 'relay' });
  assert.equal(result.ok, true, result.error);
});
test('croc auto keeps its default transport selection', async t => {
  const result = await fakeTrial(t, { tool: 'croc', route: 'auto', crocTransport: 'auto' });
  assert.equal(result.ok, true, result.error);
});
function row(tool, value, extra = {}) {
  return { tool, storage: 'tmpfs', route: 'auto', case: 'random-4k', ok: true, readyMs: value, receiverMs: value, durableMs: value, totalMs: value * 2, ...extra };
}
test('median uses middle pair and does not mutate samples', () => {
  const values = [9, 1, 7, 3]; assert.equal(median(values), 5); assert.deepEqual(values, [9, 1, 7, 3]);
});
test('gate requires every timing metric against both croc configurations', () => {
  const passing = [row('cd', 10), row('croc', 22), row('croc-no-compress', 21)];
  assert.equal(summarize(passing, 1)[0].pass2, true);
  assert.equal(summarize([...passing.slice(0, 2), row('croc-no-compress', 21, { readyMs: 14 })], 1)[0].pass1_5, false);
});
test('failed, missing or incomplete repetitions never pass', () => {
  const rows = [row('cd', 1), row('croc', 9), row('croc-no-compress', 9)];
  assert.equal(summarize(rows, 2)[0].pass1_5, false);
  assert.equal(summarize(rows.slice(0, 2), 1)[0].pass1_5, false);
  assert.equal(summarize([...rows.slice(0, 2), row('croc-no-compress', 9, { ok: false })], 1)[0].pass1_5, false);
});
test('matrix includes random and compressible small, medium and bulk payloads', () => {
  assert.deepEqual(Object.keys(cases), ['random-4k', 'random-1m', 'random-64m', 'random-256m', 'compressible-4k', 'compressible-1m', 'compressible-64m', 'compressible-256m']);
});
test('summary exposes spread while gating median results', () => {
  const rows = ['cd', 'croc', 'croc-no-compress'].flatMap(tool => [row(tool, tool === 'cd' ? 2 : 8), row(tool, tool === 'cd' ? 4 : 12)]);
  const summary = summarize(rows, 2)[0];
  assert.equal(summary.tools.cd.durableMs, 3);
  assert.deepEqual(summary.tools.cd.spread.durableMs, { min: 2, max: 4 });
  assert.equal(summary.pass2, true);
});
test('benchmark worker has isolated rate namespaces and no deployment routes', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('./bench-worker.wrangler.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.routes, []);
  assert.equal(config.main, '../worker/index.ts');
  assert.deepEqual(config.ratelimits.map(binding => binding.namespace_id), ['9237491', '9237492']);
  assert.ok(config.ratelimits.every(binding => binding.simple.limit >= 100000));
  assert.deepEqual(config.durable_objects.bindings.map(binding => binding.name), ['TRANSFERS', 'PEERS', 'CODES', 'DEVICES']);
});
