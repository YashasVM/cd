import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, randomBytes, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createWakeSender, devicePushConfigured, boundedPushJSON } from '../worker/device-push.ts';

// These keys exist only in this verification process. They are not Firebase
// credentials and cannot reach Google: every outbound request is intercepted.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = { type: 'service_account', project_id: 'cd-wake-test', client_email: 'worker@cd-wake-test.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const configured = { FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(account), FCM_PROJECT_ID: account.project_id };
const pairId = randomBytes(16).toString('base64url');
const fid = `c${randomBytes(16).toString('base64url').slice(0, 21)}`;
let clock = Date.now();
let oauthCalls = 0;
const messages = [];
let nextSend;
let oversizedOAuth = false;
async function mockGoogle(url, init) {
  if(typeof url==='string')assert.equal(init.redirect,'manual');
  const request = url && typeof url === 'object' && 'url' in url ? url : new Request(url, init);
  if (request.url === account.token_uri) {
    oauthCalls++;
    const form = new URLSearchParams(await request.text());
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jwt = form.get('assertion').split('.');
    assert.equal(jwt.length, 3);
    assert.ok(verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), publicKey, Buffer.from(jwt[2], 'base64url')));
    assert.deepEqual(JSON.parse(Buffer.from(jwt[0], 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(jwt[1], 'base64url'));
    assert.equal(claims.iss, account.client_email);
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(claims.aud, account.token_uri);
    assert.equal(claims.exp - claims.iat, 3600);
    if (oversizedOAuth) return new Response('x'.repeat(32769));
    return Response.json({ access_token: `fixture-access-${oauthCalls}`, token_type: 'Bearer', expires_in: 3600 });
  }
  assert.equal(request.url, `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`);
  assert.match(request.headers.get('authorization'), /^Bearer fixture-access-\d+$/);
  const payload = await request.json();
  assert.deepEqual(Object.keys(payload), ['message']);
  assert.deepEqual(Object.keys(payload.message).sort(), ['android', 'data', 'fid']);
  assert.deepEqual(payload.message.android, { priority: 'HIGH', ttl: '300s', collapse_key: 'cd-wake' });
  assert.deepEqual(Object.keys(payload.message.data).sort(), ['issuedAt', 'pairId', 'type', 'v']);
  assert.equal(payload.message.data.type, 'wake');
  assert.equal(payload.message.data.v, '1');
  assert.match(payload.message.data.pairId, /^[A-Za-z0-9_-]{22}$/);
  assert.match(payload.message.data.issuedAt, /^\d+$/);
  messages.push(payload);
  if (nextSend) { const response = nextSend; nextSend = undefined; return typeof response==='function'?response():response; }
  return Response.json({ name: `projects/${account.project_id}/messages/fixture` });
}
const wake = { fid, pairId, issuedAt: clock };
const send = createWakeSender({ fetch: mockGoogle, now: () => clock });
assert.equal(devicePushConfigured({}), false);
assert.equal(await send({}, wake), 'unavailable');
assert.equal(oauthCalls, 0);
assert.equal(await send({ ...configured, FCM_PROJECT_ID: 'wrong-project' }, wake), 'unavailable');
assert.equal(await send({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...account, token_uri: 'https://attacker.invalid/token' }) }, wake), 'unavailable');
assert.equal(oauthCalls, 0);
assert.equal(devicePushConfigured({...configured,FCM_PROJECT_ID:'x'.repeat(31),FCM_SERVICE_ACCOUNT_JSON:JSON.stringify({...account,project_id:'x'.repeat(31),client_email:`worker@${'x'.repeat(31)}.iam.gserviceaccount.com`})}),false);
assert.equal(devicePushConfigured({...configured,FCM_SERVICE_ACCOUNT_JSON:JSON.stringify({...account,client_email:'worker@different-project.iam.gserviceaccount.com'})}),false);
let redirectCalls=0;
const redirects=createWakeSender({fetch:async()=>{redirectCalls++;return new Response(null,{status:302,headers:{Location:'https://attacker.invalid/collect'}});}});
assert.equal(await redirects(configured,wake),'unavailable');
assert.equal(redirectCalls,1,'OAuth assertion followed a redirect');
assert.equal(await send(configured, wake), 'nudged');
assert.equal(await send(configured, wake), 'nudged');
assert.equal(oauthCalls, 1, 'short-lived OAuth credentials were not cached');
clock += 3550000;
assert.equal(await send(configured, { ...wake, issuedAt: clock }), 'nudged');
assert.equal(oauthCalls, 2, 'access token was not refreshed before expiry');
nextSend = Response.json({ error: { status: 'UNAUTHENTICATED' } }, { status: 401 });
assert.equal(await send(configured, wake), 'nudged');
assert.equal(oauthCalls, 3, 'rejected access token was not replaced');
nextSend = Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, { status: 404 });
assert.equal(await send(configured, wake), 'invalid-target');
nextSend = Response.json({ error: { status: 'INVALID_ARGUMENT' } }, { status: 400 });
assert.equal(await send(configured, wake), 'unavailable', 'generic invalid payload must not delete a target');
nextSend = Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.fid' }] }] } }, { status: 400 });
assert.equal(await send(configured, wake), 'invalid-target');
oversizedOAuth = true;
assert.equal(await createWakeSender({ fetch: mockGoogle })(configured, wake), 'unavailable');
oversizedOAuth = false;
let aborted = false;
const stalled = createWakeSender({ fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })) });
assert.equal(await stalled(configured, wake), 'unavailable');
assert.equal(aborted, true, 'OAuth timeout did not abort its fetch');
let slowBodyCanceled=false;
const slowBody=new Response(new ReadableStream({ pull(){},cancel(){slowBodyCanceled=true;} }));
await assert.rejects(boundedPushJSON(slowBody,1024),/timed out/);
assert.equal(slowBodyCanceled,true,'slow unauthenticated JSON stream was not canceled');
console.log('Verified RS256 JWT/OAuth, fixed Google endpoints, token caching/refresh, bounded responses/timeouts and data-only FID payload privacy.');

const work = await mkdtemp(join(tmpdir(), 'cd-push-verify-'));
let worker;
const now = Date.now();
const sender = randomBytes(32).toString('base64url');
const receiver = randomBytes(32).toString('base64url');
const digest = token => createHash('sha256').update(Buffer.from(token, 'base64url')).digest('base64url');
// Debug routes exist only in this generated, temporary test Worker. Production
// code has no endpoint, binding or environment option that enables them.
const fixture = `
import { DeviceRoom } from ${JSON.stringify(resolve('worker/device-room.ts'))};
import {devicePushConfigured}from ${JSON.stringify(resolve('worker/device-push.ts'))};
export class TestDeviceRoom extends DeviceRoom {
 async fetch(request) {
  const match=/^\\/__test\\/[^/]+\\/(seed|inspect|clock|age-receiver|alarm)$/.exec(new URL(request.url).pathname);
  if(match){
   if(match[1]==='alarm'){await this.alarm();return Response.json({ok:true});}
   if(match[1]==='seed'){await this.ctx.storage.put(await request.json());return Response.json({ok:true});}
   if(match[1]==='inspect'){return Response.json({target:await this.ctx.storage.get('push-target'),budget:await this.ctx.storage.get('push-budget'),configured:devicePushConfigured(this.env)});}
   if(match[1]==='clock'){const value=await request.json();Date.now=()=>value.now;return Response.json({ok:true});}
   if(match[1]==='age-receiver'){for(const socket of this.ctx.getWebSockets()){const a=socket.deserializeAttachment();if(a?.kind==='peer'&&a.role==='receiver')socket.serializeAttachment({...a,lastSeen:Date.now()-26000});}return Response.json({ok:true});}
  }
  return super.fetch(request);
 }
}
export default { async fetch(request,env){const u=new URL(request.url);const m=/^\\/(?:api\\/devices\\/v1|ws\\/devices\\/v1|__test)\\/([A-Za-z0-9_-]{22})/.exec(u.pathname);if(!m)return new Response('not found',{status:404});return env.DEVICES.getByName(m[1]).fetch(request);} };
`;
const bundle = await build({ stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: 'push-verification.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
async function start(bindings) {
  return new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-12', bindings, durableObjects: { DEVICES: { className: 'TestDeviceRoom', useSQLite: true } }, outboundService: mockGoogle }));
}
const api = path => `http://localhost/api/devices/v1/${pairId}/${path}`;
async function call(path, body, method = 'POST') { return worker.dispatchFetch(api(path), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
async function debug(action, body) { return worker.dispatchFetch(`http://localhost/__test/${pairId}/${action}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
const registration = { senderTokenHash: digest(sender), receiverTokenHash: digest(receiver), expiresAt: now + 2592000000 };
const targetRequest = { v: 1, token: receiver, fid };
const wakeRequest = { v: 1, token: sender, reason: 'offer' };
try {
  worker = await start(configured);
  assert.equal((await call('push-target', targetRequest)).status, 401, 'missing pair admitted push target');
  await debug('seed', { registration });
  assert.equal((await call('push-target', { ...targetRequest, token: sender })).status, 401);
  assert.equal((await call('push', { ...wakeRequest, token: receiver })).status, 401);
  assert.equal((await call('push-target', { ...targetRequest, token: randomBytes(32).toString('base64url') })).status, 401);
  assert.equal((await call('push-target', { ...targetRequest, fid: 'not-a-fid' })).status, 400);
  assert.equal((await call('push', { ...wakeRequest, reason: 'anything' })).status, 400);
  assert.equal((await worker.dispatchFetch(api('push'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(1025) })).status, 400);
  assert.equal((await worker.dispatchFetch(api('push-target'))).status, 405);
  assert.equal((await call('push-target', targetRequest)).status, 204);
  const snapshot = await (await debug('inspect')).json();
  assert.equal(snapshot.target.fid, fid);
  assert.ok(snapshot.target.expiresAt <= registration.expiresAt);
  assert.equal((await call('push-target', { v: 1, token: sender }, 'DELETE')).status, 401);
  const beforeConcurrent = messages.length;
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => call('push', wakeRequest)));
  assert.equal(concurrent.filter(r => r.status === 200).length, 1);
  assert.equal(concurrent.filter(r => r.status === 429).length, 7);
  assert.equal(messages.length, beforeConcurrent + 1, 'parallel requests bypassed durable cooldown');
  const success = concurrent.find(r => r.status === 200);
  const visible = await success.text();
  assert.deepEqual(JSON.parse(visible), { v: 1, status: 'nudged' });
  assert.ok(!visible.includes(fid));
  assert.equal((await call('push', wakeRequest)).status, 429);
  await debug('clock', { now: now + 31000 });
  assert.deepEqual(await (await call('push', wakeRequest)).json(), { v: 1, status: 'nudged' });
  await debug('seed', { 'push-budget': { attempts: Array.from({ length: 20 }, (_, i) => now + 31000 - 31000 - i * 60000) } });
  assert.equal((await call('push', wakeRequest)).status, 429, 'hourly cap was bypassed');
  await debug('clock', { now: now + 3700000 });
  assert.deepEqual(await (await call('push', wakeRequest)).json(), { v: 1, status: 'nudged' });
  await debug('clock',{now:now+3740000});
  const websocketResponse=await worker.dispatchFetch(`http://localhost/ws/devices/v1/${pairId}`,{headers:{Upgrade:'websocket'}});
  const socket=websocketResponse.webSocket;
  assert.ok(socket);
  socket.accept();
  const accepted=new Promise((resolve,reject)=>{
    socket.addEventListener('message',event=>{if(typeof event.data==='string'&&JSON.parse(event.data).type==='accepted')resolve();});
    socket.addEventListener('error',reject,{once:true});
  });
  socket.send(JSON.stringify({type:'join',protocol:'cd-device-v1',role:'receiver',token:receiver}));
  await accepted;
  assert.deepEqual(await(await call('push',wakeRequest)).json(),{v:1,status:'online'});
  await debug('age-receiver',{});
  assert.deepEqual(await(await call('push',wakeRequest)).json(),{v:1,status:'nudged'},'stale receiver socket suppressed wake');
  socket.close(1000,'test complete');
  assert.equal((await call('push-target', { v: 1, token: receiver }, 'DELETE')).status, 204);
  assert.deepEqual(await (await call('push', wakeRequest)).json(), { v: 1, status: 'unavailable' });
  assert.equal((await call('push-target', targetRequest)).status, 204);
  await debug('clock', { now: now + 3780000 });
  assert.equal((await call('push-target', targetRequest)).status,204);
  const generation=(await(await debug('inspect')).json()).target.generation;
  let entered,finish;
  const inFlight=new Promise(resolve=>{entered=resolve;});
  const completeInvalid=new Promise(resolve=>{finish=resolve;});
  nextSend=async()=>{entered();return completeInvalid;};
  const interrupted=call('push',wakeRequest);
  await inFlight;
  assert.equal((await call('push-target', targetRequest)).status,204);
  const renewed=(await(await debug('inspect')).json()).target;
  assert.notEqual(renewed.generation,generation);
  finish(Response.json({error:{details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'UNREGISTERED'}]}},{status:404}));
  assert.deepEqual(await(await interrupted).json(),{v:1,status:'unavailable'});
  assert.equal((await(await debug('inspect')).json()).target.generation,renewed.generation,'stale send deleted a newly registered target');
  await debug('clock',{now:now+3820000});
  nextSend = Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, { status: 404 });
  assert.deepEqual(await (await call('push', wakeRequest)).json(), { v: 1, status: 'unavailable' });
  assert.equal((await (await debug('inspect')).json()).target, undefined, 'unregistered target survived');
  await debug('seed', { registration: { ...registration, expiresAt: now - 1 } });
  assert.equal((await call('push-target', targetRequest)).status, 401, 'expired registration accepted target');
  assert.equal((await call('push', wakeRequest)).status, 401, 'expired registration accepted wake');
  await debug('alarm',{});
  assert.equal((await(await debug('inspect')).json()).target,undefined,'expired registration retained target');
  await worker.dispose();
  worker = await start({});
  await debug('seed', { registration });
  assert.equal((await call('push-target', targetRequest)).status, 204);
  assert.deepEqual(await (await call('push', wakeRequest)).json(), { v: 1, status: 'unavailable' });
  console.log('Verified real Worker role authorization, private targets, expiry, concurrent cooldown, hourly cap, invalid-target cleanup and no-config fallback.');
} finally {
  await worker?.dispose();
  await rm(work, { recursive: true, force: true });
}
