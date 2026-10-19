import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordAssembler, createRecordMerger, parseDirectOffer, splitRecord } from './direct-link.js';

function record(sequence, plaintextLength) {
  const value = new Uint8Array(12 + plaintextLength + 16).fill(sequence & 0xff);
  value.set([0x43, 0x44, 1, 2]);
  const view = new DataView(value.buffer);
  view.setUint32(4, sequence);
  view.setUint32(8, plaintextLength);
  return value;
}

test('records split into 64 KiB pieces rebuild exactly', () => {
  const first = record(0, 200_000);
  const second = record(1, 10);
  const assembler = createRecordAssembler();
  const rebuilt = [];
  for (const piece of [...splitRecord(first), ...splitRecord(second)]) {
    assert.ok(piece.byteLength <= 64 * 1024);
    rebuilt.push(...assembler.push(piece));
  }
  assert.deepEqual(rebuilt, [first, second]);
  assert.throws(() => createRecordAssembler().push(new TextEncoder().encode('garbage text here')));
});

test('the merger orders both paths and drops second copies', () => {
  const merger = createRecordMerger();
  const records = [0, 1, 2, 3].map((sequence) => record(sequence, 4));
  assert.deepEqual(merger.push(records[2]), []);
  assert.deepEqual(merger.push(records[0]), [records[0]]);
  assert.deepEqual(merger.push(records[2]), []);
  assert.deepEqual(merger.push(records[1]), [records[1], records[2]]);
  assert.deepEqual(merger.push(records[1]), []);
  assert.deepEqual(merger.push(records[3].buffer), [records[3]]);
});

test('direct offers are optional and bounded', () => {
  assert.equal(parseDirectOffer({ name: 'a' }), null);
  assert.equal(parseDirectOffer({ direct: { sdp: 'v=0' } }), 'v=0');
  assert.equal(parseDirectOffer({ direct: { sdp: 'x'.repeat(70_000) } }), null);
  assert.equal(parseDirectOffer({ direct: { sdp: 5 } }), null);
});

test('the merger bounds held bytes while a sequence is missing', () => {
  const merger = createRecordMerger();
  for (let sequence = 1; sequence <= 32; sequence += 1) {
    assert.deepEqual(merger.push(record(sequence, 1024 * 1024 - 28)), []);
  }
  assert.throws(() => merger.push(record(33, 1)), /out of order/);
});

test('the merger releases its byte budget after ordered records drain', () => {
  const merger = createRecordMerger();
  for (let sequence = 1; sequence <= 31; sequence += 1) merger.push(record(sequence, 1024 * 1024 - 28));
  assert.equal(merger.push(record(0, 1)).length, 32);
  for (let sequence = 33; sequence <= 64; sequence += 1) assert.deepEqual(merger.push(record(sequence, 1024 * 1024 - 28)), []);
});

test('assembly accepts fragmented headers and coalesced records without aliasing input', () => {
  const expected = [record(0, 1), record(1, 100_000), record(2, 0)];
  const wire = Buffer.concat(expected.map(value => Buffer.from(value)));
  for (const size of [1, 7, 13, 4096, 65536]) {
    const assembler = createRecordAssembler();
    const received = [];
    for (let at = 0; at < wire.length; at += size) {
      const piece = new Uint8Array(wire.subarray(at, at + size));
      received.push(...assembler.push(piece));
      piece.fill(0);
    }
    assert.deepEqual(received, expected);
    assert.equal(assembler.bufferedBytes, 0);
  }
});
