// Real two-machine checks: CD_TEST_HOST_KEY_ALIAS=host-alias CD_TEST_BIN_DIR=~/.local/bin
// node scripts/verify-linux-box.mjs user@host. Requires SSH key access and cdx/cdx-nightly on both hosts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { captureOutput, childExit, firstLine } from './harness.mjs';

const [target, ...extra] = process.argv.slice(2);
assert.ok(target && !extra.length && /^[\w.@:[\]-]+$/.test(target) && !target.startsWith('-'), 'Pass one SSH target: user@host');
const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
if (process.env.CD_TEST_HOST_KEY_ALIAS) sshArgs.push('-o', `HostKeyAlias=${process.env.CD_TEST_HOST_KEY_ALIAS}`);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const command = (args) => args.map(quote).join(' ');
const work = await mkdtemp(join(tmpdir(), 'cd-verify-linux-box-'));
const localBins = resolve(process.env.CD_TEST_BIN_DIR || join(homedir(), '.local/bin'));
const binaries = { stable: 'cdx', nightly: 'cdx-nightly' };
const active = new Set();
let remoteWork, remoteBins, current = 'setup', sequence = 0, succeeded = false;

function launch(binary, args, { env = process.env, input = false, timeout = 300_000 } = {}) {
  const prefix = join(work, `${String(++sequence).padStart(3, '0')}-${current}`);
  const child = spawn(binary, args, { env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL' });
  active.add(child);
  for (const name of ['stdout', 'stderr']) {
    const fd = openSync(`${prefix}.${name}`, 'wx', 0o600);
    child[name].on('data', (data) => writeSync(fd, data));
    child[name].once('end', () => closeSync(fd));
  }
  const output = captureOutput(child);
  const finished = Promise.all([childExit(child, timeout + 1000), output.finished]).then(([code]) => {
    active.delete(child);
    assert.equal(code, 0, `${current}: command failed; see private logs`);
    return output;
  });
  // Readiness can fail before the caller reaches the exit-status check.
  void finished.catch(() => {});
  return { child, output, finished };
}
function remote(args, options) {
  return launch('ssh', [...sshArgs, '--', target, command(args)], options);
}
async function remoteRun(args) { return (await remote(args).finished).stdout.trim(); }
async function upload(path, destination) {
  const operation = remote(['sh', '-c', `cat > ${quote(destination)}`], { input: true });
  await pipeline(createReadStream(path), operation.child.stdin);
  await operation.finished;
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
function endpoint(side, version, args, state, relay) {
  const settings = { CD_STATE_DIR: state, CD_NO_UPDATE_CHECK: '1', CD_TRANSPORT_REPORT: '1', CD_DIRECT: relay ? '0' : '1', CD_LAN: '1', CD_WEBRTC: '1' };
  if (side === 'local') return launch(join(localBins, binaries[version]), args, { env: { ...process.env, ...settings } });
  return remote(['timeout', '--signal=TERM', '--kill-after=5s', '300s', 'env', ...Object.entries(settings).map(([key, value]) => `${key}=${value}`), join(remoteBins, binaries[version]), ...args]);
}
async function transfer(test) {
  current = test.name;
  const receiverSide = test.senderSide === 'local' ? 'remote' : 'local';
  const paths = { local: join(work, test.name), remote: `${remoteWork}/${test.name}` };
  await mkdir(paths.local);
  await remoteRun(['mkdir', '-p', paths.remote]);
  const sourceRoot = test.senderSide === 'local' ? work : remoteWork;
  const sources = test.bundle ? [`${sourceRoot}/folder`, `${sourceRoot}/extra.txt`] : [`${sourceRoot}/${test.large ? 'large.bin' : 'payload.bin'}`];
  const sender = endpoint(test.senderSide, test.senderVersion, ['send', '--wait', '--json', ...(test.private ? ['--link'] : []), ...sources], `${paths[test.senderSide]}/sender-state`, test.relay);
  const ready = JSON.parse(await firstLine(sender.child.stdout, 30_000));
  const invitation = test.private ? ready.url : ready.code;
  assert.ok(typeof invitation === 'string' && invitation.length, 'sender did not publish invitation');
  assert.match(invitation, test.private ? /\/s\/[A-Za-z0-9_-]{22}#v1\.[A-Za-z0-9_-]{43}$/ : /^\d{4,5}$/);
  const destination = `${paths[receiverSide]}/${test.bundle ? 'received' : 'received.bin'}`;
  if (test.bundle) {
    if (receiverSide === 'local') await mkdir(destination);
    else await remoteRun(['mkdir', destination]);
  }
  const receiver = endpoint(receiverSide, test.receiverVersion, ['receive', '--json', invitation, '--out', destination], `${paths[receiverSide]}/receiver-state`, test.relay);
  const [sent, received] = await Promise.all([sender.finished, receiver.finished]);
  const result = JSON.parse(received.stdout);
  assert.equal(result.path, destination, 'receiver returned unexpected destination');
  const expected = test.bundle ? [['folder/nested/data.bin', fixtureHashes.nested, 4097], ['extra.txt', fixtureHashes.extra, 6]] : [['', fixtureHashes[test.large ? 'large' : 'payload'], test.large ? 128 * 1024 * 1024 : 64 * 1024 * 1024]];
  if (test.bundle) assert.deepEqual(result.files.map((file) => file.filename).sort(), expected.map(([name]) => name).sort());
  for (const [name, expectedHash, size] of expected) {
    const path = name ? `${destination}/${name}` : destination;
    const actualHash = receiverSide === 'local' ? await sha256(path) : (await remoteRun(['sha256sum', '--', path])).split(/\s/)[0];
    assert.equal(actualHash, expectedHash, 'received bytes differ');
    if (test.bundle) {
      const file = result.files.find((entry) => entry.filename === name);
      assert.equal(file.path, path);
      assert.equal(file.size, size);
    } else assert.equal(result.size, size);
  }
  const reports = sent.stderr.split('\n').flatMap((line) => {
    try { const value = JSON.parse(line); return value.transport ? [value] : []; } catch { return []; }
  });
  assert.equal(reports.length, 1, 'sender did not report transport');
  if (test.relay) assert.equal(reports[0].directBytes, 0, 'forced relay used direct transport');
  else if (!test.bundle) assert.ok(reports[0].directBytes > 0, 'default same-network transfer never used direct transport');
  console.log(`${test.name} PASS bytes=${expected.reduce((sum, [, , bytes]) => sum + bytes, 0)} transport=${reports[0].transport}`);
  await rm(paths.local, { recursive: true });
  await remoteRun(['rm', '-rf', '--', paths.remote]);
}

const fixtureHashes = {};
try {
  remoteBins = `${await remoteRun(['sh', '-c', 'printf %s "$HOME"'])}/.local/bin`;
  remoteWork = await remoteRun(['mktemp', '-d', '/tmp/cd-verify-linux-box.XXXXXX']);
  assert.match(remoteWork, /^\/tmp\/cd-verify-linux-box\.[A-Za-z0-9]+$/);
  const bytes = randomBytes(128 * 1024 * 1024);
  await writeFile(join(work, 'large.bin'), bytes, { mode: 0o600 });
  await writeFile(join(work, 'payload.bin'), bytes.subarray(0, 64 * 1024 * 1024), { mode: 0o600 });
  await mkdir(join(work, 'folder/nested'), { recursive: true });
  await writeFile(join(work, 'folder/nested/data.bin'), bytes.subarray(0, 4097), { mode: 0o600 });
  await writeFile(join(work, 'extra.txt'), 'extra\n', { mode: 0o600 });
  await remoteRun(['mkdir', '-p', `${remoteWork}/folder/nested`]);
  for (const [key, path] of [['large', 'large.bin'], ['payload', 'payload.bin'], ['nested', 'folder/nested/data.bin'], ['extra', 'extra.txt']]) {
    fixtureHashes[key] = await sha256(join(work, path));
    await upload(join(work, path), `${remoteWork}/${path}`);
  }
  for (const [localVersion, remoteVersion] of [['stable', 'stable'], ['nightly', 'nightly'], ['stable', 'nightly'], ['nightly', 'stable']]) {
    for (const senderSide of ['local', 'remote']) for (const relay of [false, true]) {
      await transfer({ name: `${localVersion}-${remoteVersion}-${senderSide}-${relay ? 'relay' : 'default'}`, senderSide,
        senderVersion: senderSide === 'local' ? localVersion : remoteVersion,
        receiverVersion: senderSide === 'local' ? remoteVersion : localVersion, relay,
        large: localVersion === 'stable' && remoteVersion === 'stable' && senderSide === 'local' && relay });
    }
  }
  await transfer({ name: 'private-link', senderSide: 'local', senderVersion: 'stable', receiverVersion: 'nightly', private: true });
  for (const senderSide of ['local', 'remote']) await transfer({ name: `bundle-${senderSide}`, senderSide, senderVersion: 'nightly', receiverVersion: 'stable', bundle: true });
  await remoteRun(['rm', '-rf', '--', remoteWork]);
  succeeded = true;
} catch (error) {
  await writeFile(join(work, 'failure.txt'), String(error.stack || error), { mode: 0o600 });
  console.error(`${current} FAIL; private logs and fixtures kept at ${work}${remoteWork ? ` and ${target}:${remoteWork}` : ''}`);
  process.exitCode = 1;
} finally {
  for (const child of active) child.kill('SIGKILL');
  if (succeeded) await rm(work, { recursive: true, force: true });
}
