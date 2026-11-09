import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Run the public web/Android APIs against the real Worker and SQLite DOs, without deployment.
const work = await mkdtemp(join(tmpdir(), 'cd-android-sdk-'));
let relay;
try {
  const scriptPath = join(work, 'worker.mjs');
  await build({ entryPoints: ['worker/index.ts'], bundle: true, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers'], outfile: scriptPath });
  const { workerOptions } = unstable_getMiniflareWorkerOptions('wrangler.jsonc');
  const ratelimits = structuredClone(workerOptions.ratelimits);
  // These behavior tests share one IP; production rate limits are covered by the security suite.
  ratelimits.CONNECTION_RATE_LIMITER.simple.limit = 1000;
  relay = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: workerOptions.compatibilityDate, compatibilityFlags: workerOptions.compatibilityFlags,
    durableObjects: workerOptions.durableObjects, ratelimits,
    name: 'cd-android-sdk', rootPath: work, modulesRoot: work, modules: true, scriptPath,
    host: '127.0.0.1', port: 0, inspectorPort: 0, durableObjectsPersist: join(work, 'state'),
    log: new Log(LogLevel.WARN), outboundService: () => { throw new Error('Unexpected internet egress'); },
  }));
  const url = await relay.ready;
  if (process.env.CD_SDK_SUITE === 'browser') {
    const { verifyWebExample } = await import('./verify-sdk-browser.mjs');
    await verifyWebExample(url.origin);
  } else if (process.env.CD_SDK_SUITE === 'web') {
    const child = spawn(process.execPath, ['--test', 'packages/transfer-web/test/api.test.mjs', 'packages/transfer-web/test/live-relay.test.mjs', 'examples/transfer-web/main.test.mjs'], { stdio: 'inherit', env: { ...process.env, CD_SDK_RELAY: url.origin } });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error(`Web SDK tests exited ${code}`);
  } else {
    const child = spawn('android/gradlew', ['-p', 'android', ':transfer:testDebugUnitTest', '--rerun-tasks', '--console=plain'], {
      stdio: 'inherit', env: { ...process.env, CD_SDK_RELAY: url.origin, CD_SDK_WEB_PEER: join(process.cwd(), 'scripts/sdk-web-peer.mjs') },
    });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(new Error(`Gradle terminated by ${signal}`)) : resolve(code)); });
    if (code !== 0) throw new Error(`Android SDK integration tests exited ${code}`);
  }
} finally {
  await relay?.dispose();
  await rm(work, { recursive: true, force: true });
}
