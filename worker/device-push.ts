// FCM is an optional wake hint. File data and device credentials never enter it.
export type DevicePushEnvironment = { FCM_SERVICE_ACCOUNT_JSON?: string; FCM_PROJECT_ID?: string };
export type WakeResult = 'nudged' | 'unavailable' | 'invalid-target';
type Account = { project: string; email: string; pem: string };
type Access = { token: string; expiresAt: number };
type Wake = { fid: string; pairId: string; issuedAt: number };
type Dependencies = { fetch?: typeof fetch; now?: () => number };
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const encoder = new TextEncoder();

function account(env: DevicePushEnvironment): Account | null {
  if (!env.FCM_SERVICE_ACCOUNT_JSON || env.FCM_SERVICE_ACCOUNT_JSON.length > 16384) return null;
  let value: unknown;
  try { value = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON); } catch { return null; }
  if (!value || typeof value !== 'object'
    || !('project_id' in value) || typeof value.project_id !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.project_id)
    || !('client_email' in value) || typeof value.client_email !== 'string' || value.client_email.length > 320 || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(value.client_email)
    || !('private_key' in value) || typeof value.private_key !== 'string' || value.private_key.length > 12000
    || !/^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+\s+-----END PRIVATE KEY-----\s*$/.test(value.private_key)
    || !('token_uri' in value) || value.token_uri !== TOKEN_URL
    || ('type' in value && value.type !== 'service_account')
    || !value.client_email.endsWith(`@${value.project_id}.iam.gserviceaccount.com`)
    || (env.FCM_PROJECT_ID !== undefined && env.FCM_PROJECT_ID !== value.project_id)) return null;
  return { project: value.project_id, email: value.client_email, pem: value.private_key };
}
export function devicePushConfigured(env: DevicePushEnvironment): boolean { return account(env) !== null; }
function encoded(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function part(value: unknown): string { return encoded(encoder.encode(JSON.stringify(value))); }

// Bound both caller-controlled JSON and Google responses before buffering.
export async function boundedPushJSON(body: Request | Response, limit: number): Promise<unknown> {
  const length = body.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('JSON exceeds limit');
  const reader = body.body?.getReader();
  if (!reader) throw new Error('JSON body required');
  const chunks: Uint8Array[] = []; let size = 0; let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      expired = true;
      reject(new Error('JSON body timed out'));
      void reader.cancel().catch(() => {});
    }, 5000);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (expired) throw new Error('JSON body timed out');
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); throw new Error('JSON exceeds limit'); }
      chunks.push(next.value);
    }
  } finally { clearTimeout(timeout); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function invalidTarget(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('error' in value) || !value.error || typeof value.error !== 'object'
    || !('details' in value.error) || !Array.isArray(value.error.details)) return false;
  const details: unknown[] = value.error.details;
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    if ('@type' in detail && detail['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && 'errorCode' in detail && detail.errorCode === 'UNREGISTERED') return true;
    if ('@type' in detail && detail['@type'] === 'type.googleapis.com/google.rpc.BadRequest' && 'fieldViolations' in detail && Array.isArray(detail.fieldViolations)
      && detail.fieldViolations.some((v: unknown) => !!v && typeof v === 'object' && 'field' in v && (v.field === 'message.fid' || v.field === 'message.token'))) return true;
  }
  return false;
}

// Injection is a code-only verification seam. Production endpoints are fixed;
// no environment setting can redirect OAuth assertions or bearer tokens.
export function createWakeSender(dependencies: Dependencies = {}) {
  const transport = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  let cached: { account: string; key: CryptoKey; access: Access | null } | null = null;
  async function request(url: string, init: RequestInit): Promise<{ status: number; value: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await transport(url, { ...init, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw new Error('Redirect refused'); }
      const value = await boundedPushJSON(response, 32768);
      return { status: response.status, value };
    } finally { clearTimeout(timeout); }
  }
  async function access(config: Account, identity: string, refresh: boolean): Promise<string> {
    if (!cached || cached.account !== identity) {
      const raw = atob(config.pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''));
      const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(raw, c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
      cached = { account: identity, key, access: null };
    }
    const state = cached;
    if (!refresh && state.access && state.access.expiresAt > now() + 60000) return state.access.token;
    const issued = Math.floor(now() / 1000);
    const assertion = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: config.email, scope: SCOPE, aud: TOKEN_URL, iat: issued, exp: issued + 3600 })}`;
    const signed = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', state.key, encoder.encode(assertion));
    const oauth = await request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${assertion}.${encoded(new Uint8Array(signed))}` }) });
    const result = oauth.value;
    if (oauth.status !== 200 || !result || typeof result !== 'object'
      || !('access_token' in result) || typeof result.access_token !== 'string' || !/^[A-Za-z0-9._~+\/-]{1,16384}={0,2}$/.test(result.access_token)
      || !('expires_in' in result) || typeof result.expires_in !== 'number' || !Number.isSafeInteger(result.expires_in) || result.expires_in <= 0 || result.expires_in > 3600
      || ('token_type' in result && result.token_type !== 'Bearer')) throw new Error('OAuth unavailable');
    state.access = { token: result.access_token, expiresAt: now() + result.expires_in * 1000 };
    return result.access_token;
  }
  return async (env: DevicePushEnvironment, wake: Wake): Promise<WakeResult> => {
    const config = account(env); if (!config) return 'unavailable';
    try {
      const identity = `${config.project}\n${config.email}\n${config.pem}`;
      const payload = { message: { fid: wake.fid, android: { priority: 'HIGH', ttl: '300s', collapse_key: 'cd-wake' }, data: { v: '1', type: 'wake', pairId: wake.pairId, issuedAt: String(wake.issuedAt) } } };
      const endpoint = `https://fcm.googleapis.com/v1/projects/${config.project}/messages:send`;
      for (const refresh of [false, true]) {
        const token = await access(config, identity, refresh);
        const result = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
        if (result.status === 401 && !refresh) continue;
        if (result.status >= 200 && result.status < 300 && result.value && typeof result.value === 'object'
          && 'name' in result.value && typeof result.value.name === 'string' && result.value.name.startsWith(`projects/${config.project}/messages/`) && result.value.name.length < 512) return 'nudged';
        return invalidTarget(result.value) ? 'invalid-target' : 'unavailable';
      }
    } catch { /* Optional push failure leaves the existing transports available. */ }
    return 'unavailable';
  };
}
export const sendDeviceWake = createWakeSender();
