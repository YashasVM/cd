import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { resumeReceiverAdmission, resumeNonceProof, createResumeSealer } from '../src/resume-protocol.js';
import { encodeBase64Url } from '../src/agent-protocol.js';

const port = 8790;
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
const sockets = [];
try {
  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with ${child.exitCode}`);
    try { await fetch(`${origin}/api/health`); ready = true; break; } catch { await delay(250); }
  }
  assert.equal(ready, true, 'local Worker should start');
  const random = (n) => crypto.getRandomValues(new Uint8Array(n));
  const invitation = { id: random(16), key: random(32) };
  const rootId = encodeBase64Url(invitation.id);
  const admission = await resumeReceiverAdmission(invitation);
  const receiverToken = encodeBase64Url(admission.token);
  const receiverTokenHash = encodeBase64Url(admission.digest);
  const senderToken = encodeBase64Url(random(32));
  const hashSender = async (token) => encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', decode(token))));
  function decode(value) { const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
  const realSenderHash = await hashSender(senderToken);

  const connect = async (join) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/v2/${rootId}`);
    sockets.push(socket);
    await once(socket, 'open');
    const messages = [];
    socket.addEventListener('close', event => messages.push({type:'CLOSED',code:event.code,reason:event.reason}));
    socket.addEventListener('message', event => messages.push(typeof event.data === 'string' ? JSON.parse(event.data) : event.data));
    socket.send(JSON.stringify(join));
    return { socket, messages, async until(type) { for (let i=0;i<100;i++){const found=messages.find(m=>m?.type===type);if(found)return found;await delay(10);} throw new Error(`timed out waiting for ${type}; got ${JSON.stringify(messages)}`); } };
  };
  const senderJoin = (token, sessionNonce, initial = false, includeHashes = initial) => ({ type:'join', protocol:'cd-transfer-v2', role:'sender', senderToken:token, ...(includeHashes?{senderTokenHash:realSenderHash,receiverTokenHash}:{}), sessionNonce:encodeBase64Url(sessionNonce), nonceProof:encodeBase64Url(new Uint8Array(32)) });
  const wrongInitial = await connect(senderJoin(encodeBase64Url(random(32)), random(32), true));
  await once(wrongInitial.socket, 'close');
  const initialNonce = random(32);
  const initialProof = await resumeNonceProof(invitation,'sender',initialNonce);
  const sender = await connect({...senderJoin(senderToken,initialNonce,true),nonceProof:encodeBase64Url(initialProof)});
  await sender.until('accepted');
  const badReceiverNonce = random(32);
  const badReceiver = await connect({type:'join',protocol:'cd-transfer-v2',role:'receiver',receiverToken:encodeBase64Url(random(32)),receiverNonce:encodeBase64Url(badReceiverNonce),nonceProof:encodeBase64Url(await resumeNonceProof(invitation,'receiver',badReceiverNonce))});
  await once(badReceiver.socket,'close');

  const receiverNonce = random(32);
  const receiver = await connect({type:'join',protocol:'cd-transfer-v2',role:'receiver',receiverToken,receiverNonce:encodeBase64Url(receiverNonce),nonceProof:encodeBase64Url(await resumeNonceProof(invitation,'receiver',receiverNonce))});
  await receiver.until('accepted'); await sender.until('peer-joined');
  receiver.socket.close();
  await once(sender.socket,'close');

  const wrongReconnect = await connect(senderJoin(encodeBase64Url(random(32)),random(32)));
  await once(wrongReconnect.socket,'close');
  const replay = await connect(senderJoin(senderToken,initialNonce));
  await once(replay.socket,'close');

  const resumedNonce = random(32), resumedProof = await resumeNonceProof(invitation,'sender',resumedNonce);
  const resumed = await connect({...senderJoin(senderToken,resumedNonce,false,true),nonceProof:encodeBase64Url(resumedProof)});
  await resumed.until('accepted');
  const resumedReceiverNonce = random(32), resumedReceiverProof = await resumeNonceProof(invitation,'receiver',resumedReceiverNonce);
  const resumedReceiver = await connect({type:'join',protocol:'cd-transfer-v2',role:'receiver',receiverToken,receiverNonce:encodeBase64Url(resumedReceiverNonce),nonceProof:encodeBase64Url(resumedReceiverProof)});
  await resumedReceiver.until('accepted'); await resumed.until('peer-joined');
  const sealer = await createResumeSealer(invitation,1,{sessionNonce:resumedNonce,receiverNonce:resumedReceiverNonce});
  resumedReceiver.socket.send(await sealer.seal(6,new TextEncoder().encode('complete')));
  await delay(30);
  resumedReceiver.socket.send(JSON.stringify({type:'complete',protocol:'cd-transfer-v2',sessionNonce:encodeBase64Url(resumedNonce),receiverNonce:encodeBase64Url(resumedReceiverNonce)}));
  await resumed.until('completed'); await resumedReceiver.until('completed');
  const terminal = new WebSocket(`ws://127.0.0.1:${port}/ws/v2/${rootId}`); sockets.push(terminal);
  const [response] = await Promise.race([once(terminal,'error'),delay(2000).then(()=>{throw new Error('terminal root unexpectedly connected');})]);
  assert.ok(response);
  console.log('resume relay authentication, replay, interruption, recovery, COMPLETE and terminal checks passed');
} finally {
  for (const socket of sockets) try { socket.close(); } catch {}
  child.kill('SIGTERM');
  await delay(100);
}
