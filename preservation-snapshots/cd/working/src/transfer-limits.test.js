import assert from 'node:assert/strict';
import test from 'node:test';
import {selectReceiveChunkSize,acceptedSendChunkSize} from './transfer-limits.js';
const encode=value=>new TextEncoder().encode(JSON.stringify(value));
test('old senders and receivers retain their original wire chunk sizes',()=>{
 assert.equal(selectReceiveChunkSize({chunkSize:65536}),65536);
 assert.equal(selectReceiveChunkSize({chunkSize:262144}),262144);
 assert.equal(acceptedSendChunkSize(new Uint8Array()),262144);
});
test('new peers explicitly negotiate 768 KiB records',()=>{
 assert.equal(selectReceiveChunkSize({chunkSize:262144,maxChunkSize:786432}),786432);
 assert.equal(acceptedSendChunkSize(encode({chunkSize:786432})),786432);
 assert.equal(acceptedSendChunkSize(encode({chunkSize:262144})),262144);
});
test('unknown limits and malformed selections fail closed',()=>{
 for(const offer of [{chunkSize:786432},{chunkSize:262144,maxChunkSize:1048576},{chunkSize:262144,maxChunkSize:null}]) assert.throws(()=>selectReceiveChunkSize(offer),/limits/);
 for(const payload of [encode(null),encode([]),encode({chunkSize:1048576}),encode({chunkSize:786432,lan:{port:80}}),encode({}),new Uint8Array([255]),new Uint8Array(4097)])assert.throws(()=>acceptedSendChunkSize(payload),/selection/);
});
