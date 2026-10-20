import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const moduleURL = process.env.CD_ASSEMBLY_MODULE
  ? pathToFileURL(process.env.CD_ASSEMBLY_MODULE).href
  : new URL('../src/direct-link.js', import.meta.url).href;
const { createRecordAssembler, splitRecord } = await import(moduleURL);
const record = new Uint8Array(256 * 1024 + 28).map((_, i) => i % 251);
record.set([0x43, 0x44, 1, 2]);
new DataView(record.buffer).setUint32(8, record.length - 28);
const pieces = splitRecord(record);
const trials = [];
for (let run = -1; run < 7; run++) {
  const assembler = createRecordAssembler();
  let count = 0;
  const start = performance.now();
  for (let i = 0; i < 512; i++) {
    for (const piece of pieces) {
      for (const received of assembler.push(piece)) {
        assert.ok(Buffer.from(received.buffer, received.byteOffset, received.byteLength).equals(Buffer.from(record.buffer)));
        count++;
      }
    }
  }
  const milliseconds = performance.now() - start;
  assert.equal(count, 512);
  assert.equal(assembler.bufferedBytes, 0);
  if (run >= 0) trials.push({ milliseconds, mibPerSecond: 128 / (milliseconds / 1000) });
}
console.log(JSON.stringify({ moduleURL, node: process.version, payloadMiB: 128, verified: true, trials }, null, 2));
