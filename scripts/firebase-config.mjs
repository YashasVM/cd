import { createPrivateKey } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
export function validateFirebaseConfig(projectId, android, account) {
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('Use the Firebase project ID, between 6 and 30 lowercase letters, digits or hyphens.');
  if (android?.project_info?.project_id !== projectId || !/^\d+$/.test(android?.project_info?.project_number ?? '')) throw new Error('Android configuration belongs to a different or invalid Firebase project.');
  const client = Array.isArray(android?.client) ? android.client.find(value => value?.client_info?.android_client_info?.package_name === 'in.yash0.cd') : undefined;
  if (!client || typeof client.client_info.mobilesdk_app_id !== 'string' || !client.client_info.mobilesdk_app_id.startsWith(`1:${android.project_info.project_number}:android:`) || !Array.isArray(client.api_key) || !client.api_key.some(key => typeof key?.current_key === 'string' && key.current_key.length > 0)) throw new Error('Register the Android package in.yash0.cd and download its google-services.json.');
  if (account?.type !== 'service_account' || account.project_id !== projectId || typeof account.client_email !== 'string' || !account.client_email.endsWith(`@${projectId}.iam.gserviceaccount.com`) || account.token_uri !== 'https://oauth2.googleapis.com/token' || (account.universe_domain !== undefined && account.universe_domain !== 'googleapis.com') || JSON.stringify(account).length > 16384) throw new Error('Use a Google service-account JSON key from the same Firebase project.');
  try {
    if (typeof account.private_key !== 'string' || !account.private_key.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error();
    const key = createPrivateKey(account.private_key);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
  } catch { throw new Error('The service-account JSON does not contain a valid RSA signing key.'); }
}

async function jsonFile(path, label) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`Cannot read ${label} as JSON. Its contents have not been logged.`); }
}
async function ordinary(path, directory = false) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Firebase setup paths must be ordinary files and directories.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function installFirebaseConfig(root, projectId, androidPath, accountPath) {
  const android = await jsonFile(androidPath, 'Android configuration');
  const account = await jsonFile(accountPath, 'service-account key');
  validateFirebaseConfig(projectId, android, account);
  const privateDir = join(root, '.firebase');
  const destination = join(root, 'android/app/google-services.json');
  await ordinary(privateDir, true);
  await ordinary(destination);
  for (const path of [destination, join(privateDir, 'service-account.json')]) {
    try {
      const existing = await jsonFile(path, 'existing Firebase configuration');
      const existingProject = existing.project_info?.project_id ?? existing.project_id;
      if (existingProject !== projectId) throw new Error('A different Firebase project is already configured. Use a separate checkout or remove that configuration explicitly.');
    } catch (error) {
      try { await lstat(path); } catch (missing) { if (missing.code === 'ENOENT') continue; }
      throw error;
    }
  }
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  await chmod(privateDir, 0o700);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(privateDir, 'install-'));
  try {
    const contents = [
      [destination, android],
      [join(privateDir, 'service-account.json'), account],
      [join(privateDir, 'worker-secrets.json'), { FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(account) }]
    ];
    for (let i = 0; i < contents.length; i++) {
      const [path, content] = contents[i];
      await ordinary(path);
      const staged = join(temporary, String(i));
      await writeFile(staged, JSON.stringify(content, null, 2) + '\n', { mode: 0o600 });
      await rename(staged, path);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function checkFirebaseConfig(root) {
  const android = await jsonFile(join(root, 'android/app/google-services.json'), 'Android configuration');
  const account = await jsonFile(join(root, '.firebase/service-account.json'), 'service-account key');
  validateFirebaseConfig(android?.project_info?.project_id, android, account);
  const bundle = await jsonFile(join(root, '.firebase/worker-secrets.json'), 'Worker secret bundle');
  if (Object.keys(bundle).length !== 1 || bundle.FCM_SERVICE_ACCOUNT_JSON !== JSON.stringify(account)) throw new Error('Worker secret bundle differs from the validated service account. Rerun the setup wizard.');
  for (const path of ['.firebase', '.firebase/service-account.json', '.firebase/worker-secrets.json']) {
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Firebase credentials require a private directory and files. Rerun the setup wizard.');
  }
  return android.project_info.project_id;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, projectId, androidPath, accountPath] = process.argv.slice(2);
    if (command === 'install' && accountPath) {
      await installFirebaseConfig(repository, projectId, resolve(androidPath), resolve(accountPath));
      console.log('Prepared Android configuration and a private Worker secret bundle. Nothing was deployed.');
    } else if (command === 'check') {
      const id = await checkFirebaseConfig(repository);
      console.log(`Firebase configuration is valid for ${id} and Android package in.yash0.cd. Secret values were not printed.`);
    } else {
      console.log('Usage: node scripts/firebase-config.mjs install <project-id> <google-services.json path> <service-account.json path>\n       node scripts/firebase-config.mjs check');
      if (command !== '--help') process.exitCode = 2;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
