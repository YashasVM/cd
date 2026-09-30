import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Shared helpers for the CLI loop and benchmark scripts: build the CLI, run a
// local Worker, and drive child processes with timeouts.

export async function buildCLI(work) {
  const executable = join(work, process.platform === 'win32' ? 'cdx.exe' : 'cdx');
  await run('go', ['build', '-buildvcs=false', '-trimpath', '-o', executable, './cmd/cd']);
  return executable;
}

// startWorker runs `wrangler dev` on a free loopback port. CD_VERIFY_URL
// points the scripts at a deployed Worker instead.
export async function startWorker(work) {
  const hosted = process.env.CD_VERIFY_URL;
  if (hosted) {
    const publicBase = new URL(hosted).origin;
    return { publicBase, relayBase: publicBase.replace(/^http/, 'ws') + '/ws/v1', stop: async () => {} };
  }
  const port = await availablePort();
  const publicBase = `http://127.0.0.1:${port}`;
  const wranglerCli = fileURLToPath(import.meta.resolve('wrangler'));
  const child = spawn(process.execPath, [wranglerCli, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(work, 'wrangler-state')], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.resume();
  child.stderr.resume();
  await waitForHealth(`${publicBase}/api/health`, child);
  return { publicBase, relayBase: publicBase.replace(/^http/, 'ws') + '/ws/v1', stop: () => stopChild(child) };
}

export function cliEnv(worker, extra = {}) {
  return { ...process.env, CD_RELAY_URL: worker.relayBase, CD_PUBLIC_URL: worker.publicBase, ...extra };
}

export async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await killed;
  }
}

export async function run(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = collect(child.stderr);
  const code = await childExit(child);
  assert.equal(code, 0, await stderr);
}

export function childExit(child, timeoutMilliseconds = 120_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return withTimeout(new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }), timeoutMilliseconds, 'child process did not exit');
}

export async function waitForHealth(url, child) {
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('wrangler stopped before becoming ready');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('wrangler did not become ready');
}

export function collect(stream) {
  let output = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { output += chunk; });
  return new Promise((resolve) => stream.on('end', () => resolve(output)));
}

export function firstLine(stream, timeoutMilliseconds = 10_000) {
  return withTimeout(new Promise((resolve, reject) => {
    let output = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline !== -1) resolve(output.slice(0, newline).trim());
    });
    stream.on('end', () => reject(new Error(`sender ended before printing a line: ${output}`)));
  }), timeoutMilliseconds, 'sender did not print a line');
}

export function withTimeout(promise, timeoutMilliseconds, message) {
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timeout));
}
