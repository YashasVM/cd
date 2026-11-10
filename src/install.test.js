import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Exercise downloads and checksums without reaching GitHub or replacing a real CLI.
test('stable and nightly installers use separate assets and coexist', () => {
  const work = mkdtempSync(join(tmpdir(), 'cd-install-test-'));
  try {
    const bin = join(work, 'bin');
    mkdirSync(bin);
    const payload = '#!/bin/sh\nexit 0\n';
    const digest = createHash('sha256').update(payload).digest('hex');
    const fixture = join(work, 'fixture');
    writeFileSync(fixture, payload);
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n', { mode: 0o755 });
    writeFileSync(join(bin, 'curl'), `#!/bin/sh
for arg do
  case "$arg" in https:*) url="$arg";; esac
  output="$arg"
done
echo "$url" >> "$INSTALL_LOG"
case "$url" in
  */checksums.txt) printf '%s  %s\\n' '${digest}' "$INSTALL_ASSET" > "$output" ;;
  *) cp "$INSTALL_FIXTURE" "$output" ;;
esac
`, { mode: 0o755 });
    const log = join(work, 'downloads');
    const installDir = join(work, 'installed');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CD_INSTALL_DIR: installDir, CD_AGENT_SETUP: '0', CD_LOCAL_BINARY: '', CD_VERSION: '', CDX_VERSION: '', INSTALL_FIXTURE: fixture, INSTALL_LOG: log };
    for (const channel of ['stable', 'nightly']) {
      const command = channel === 'stable' ? 'cdx' : 'cdx-nightly';
      const result = spawnSync('sh', ['scripts/install.sh'], { env: { ...env, CD_CHANNEL: channel, INSTALL_ASSET: `${command}-linux-amd64` }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(installDir, command), 'utf8'), payload);
    }
    assert.match(readFileSync(log, 'utf8'), /releases\/latest\/download\/cdx-linux-amd64/);
    assert.match(readFileSync(log, 'utf8'), /releases\/download\/nightly\/cdx-nightly-linux-amd64/);
    const invalid = spawnSync('sh', ['scripts/install.sh'], { env: { ...env, CD_CHANNEL: 'wrong' }, encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /CD_CHANNEL must be stable or nightly/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
