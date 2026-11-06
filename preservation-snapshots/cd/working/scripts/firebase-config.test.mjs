import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkFirebaseConfig, installFirebaseConfig, validateFirebaseConfig } from './firebase-config.mjs';

// These fixtures are local test data, with a fresh throwaway RSA key. Tests do
// not create a Firebase project, call Google, or install real credentials.
const project = 'cd-push-test';
const android = { project_info: { project_id: project, project_number: '123456789' }, client: [{ client_info: { mobilesdk_app_id: '1:123456789:android:abcdef0123456789', android_client_info: { package_name: 'in.yash0.cd' } }, api_key: [{ current_key: 'synthetic-public-test-key' }] }] };
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const account = { type: 'service_account', project_id: project, client_email: `cd-wake@${project}.iam.gserviceaccount.com`, private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token' };

test('Firebase configuration binds Android package, project and signing identity', () => {
  validateFirebaseConfig(project, android, account);
  assert.throws(() => validateFirebaseConfig('another-project', android, account), /different/);
  assert.throws(() => validateFirebaseConfig(project, { ...android, client: [] }, account), /in.yash0.cd/);
  assert.throws(() => validateFirebaseConfig(project, android, { ...account, token_uri: 'https://attacker.example/token' }), /Google service-account/);
  assert.throws(() => validateFirebaseConfig(project, android, { ...account, private_key: 'invalid' }), /valid RSA/);
});

test('Firebase setup writes a private, reusable bundle and rejects cross-project replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cd-firebase-config-'));
  try {
    const androidPath = join(root, 'downloaded-android.json'), keyPath = join(root, 'downloaded-account.json');
    await writeFile(androidPath, JSON.stringify(android));
    await writeFile(keyPath, JSON.stringify(account), { mode: 0o600 });
    await installFirebaseConfig(root, project, androidPath, keyPath);
    assert.equal(await checkFirebaseConfig(root), project);
    const bundle = JSON.parse(await readFile(join(root, '.firebase/worker-secrets.json'), 'utf8'));
    assert.deepEqual(Object.keys(bundle), ['FCM_SERVICE_ACCOUNT_JSON']);
    assert.equal(JSON.parse(bundle.FCM_SERVICE_ACCOUNT_JSON).private_key, privateKey);
    if (process.platform !== 'win32') {
      assert.equal((await lstat(join(root, '.firebase'))).mode & 0o777, 0o700);
      assert.equal((await lstat(join(root, '.firebase/worker-secrets.json'))).mode & 0o777, 0o600);
    }
    await installFirebaseConfig(root, project, androidPath, keyPath);
    assert.equal(await checkFirebaseConfig(root), project);
    await writeFile(join(root, 'android/app/google-services.json'), JSON.stringify({ project_info: { project_id: 'other-project' } }));
    await assert.rejects(installFirebaseConfig(root, project, androidPath, keyPath), /different Firebase project/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Firebase setup does not follow an existing private-directory symlink', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cd-firebase-symlink-'));
  try {
    const androidPath = join(root, 'android.json'), keyPath = join(root, 'account.json');
    await writeFile(androidPath, JSON.stringify(android));
    await writeFile(keyPath, JSON.stringify(account), { mode: 0o600 });
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(root, '.firebase'));
    await assert.rejects(installFirebaseConfig(root, project, androidPath, keyPath), /ordinary files/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
