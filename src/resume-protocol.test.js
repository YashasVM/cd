import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { createResumeSealer, createResumeOpener, resumeReceiverAdmission, resumeNonceProof, verifyResumeNonceProof, signResumeCheckpoint, verifyResumeCheckpoint } from './resume-protocol.js';
import { decodeBase64Url } from './agent-protocol.js';

globalThis.crypto ??= webcrypto;
const fixture=JSON.parse(await readFile(new URL('../fixtures/resume-v2.json',import.meta.url),'utf8'));
const invitation={id:decodeBase64Url(fixture.invitation.rootId),key:decodeBase64Url(fixture.invitation.masterKey)};
const sessionNonce=decodeBase64Url(fixture.sessionNonce),receiverNonce=decodeBase64Url(fixture.receiverNonce);

test('v2 fresh nonces produce distinct authenticated records at sequence zero', async()=>{
  const p=new TextEncoder().encode(fixture.plaintext),s1=await createResumeSealer(invitation,0,{sessionNonce,receiverNonce}),o1=await createResumeOpener(invitation,0,{sessionNonce,receiverNonce});
  const record=await s1.seal(fixture.kind,p);assert.deepEqual((await o1.open(record)).plaintext,p);
  const next=await createResumeSealer(invitation,0,{sessionNonce:new Uint8Array(32).fill(9),receiverNonce}),different=await next.seal(fixture.kind,p);assert.notDeepEqual(record,different);
});
test('admission nonce proofs authenticate role, root and nonce', async()=>{
  const admission=await resumeReceiverAdmission(invitation);assert.equal(admission.token.length,32);assert.equal(admission.digest.length,32);
  const proof=await resumeNonceProof(invitation,'sender',sessionNonce);assert.equal(await verifyResumeNonceProof(invitation,'sender',sessionNonce,proof),true);
  assert.equal(await verifyResumeNonceProof(invitation,'receiver',sessionNonce,proof),false);
});
test('checkpoint MAC binds fields and expiry', async()=>{
  const cp=await signResumeCheckpoint({role:'receiver',rootId:fixture.invitation.rootId,filename:'f',size:1,chunkSize:262144,wholeSha256:'a'.repeat(64),offset:1,prefixSha256:'b'.repeat(64),stagingId:'stage',destination:'/tmp/f',expiresAt:Date.now()+60000,priorSessionNonce:fixture.sessionNonce},invitation.key);
  assert.equal(await verifyResumeCheckpoint(cp,invitation.key),true);assert.equal(await verifyResumeCheckpoint({...cp,offset:0},invitation.key),false);assert.equal(await verifyResumeCheckpoint(cp,invitation.key,cp.expiresAt),false);
});
