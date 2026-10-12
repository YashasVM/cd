import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// Shared plumbing for the verify-*.mjs scripts: local Worker, Chromium, and
// child-process helpers.

export async function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('Chromium was not found; set CHROMIUM_PATH to run the browser transfer check');
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

export function childExit(child) {
  return withTimeout(new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }), 120_000, 'child process did not exit');
}

export async function waitForHealth(url, child) {
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

export function firstLine(stream) {
  return withTimeout(new Promise((resolve, reject) => {
    let output = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline !== -1) resolve(output.slice(0, newline).trim());
    });
    stream.on('end', () => reject(new Error(`sender ended before printing a URL: ${output}`)));
  }), 10_000, 'sender did not print a URL');
}

export function withTimeout(promise, timeoutMilliseconds, message) {
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timeout));
}
