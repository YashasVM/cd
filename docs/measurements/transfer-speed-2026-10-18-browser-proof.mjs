import assert from 'node:assert/strict';
import { createRecordAssembler, splitRecord } from '../../src/direct-link.js';
import { createSendWindow } from '../../src/send-window.js';

// Count copies performed by the real assembler. This does not measure elapsed time.
const record = new Uint8Array(256 * 1024 + 28);
record.set([0x43, 0x44, 1, 3]);
new DataView(record.buffer).setUint32(8, 256 * 1024);
const pieces = splitRecord(record);
const originalSet = Uint8Array.prototype.set;
const originalSlice = Uint8Array.prototype.slice;
let copiedBytes = 0;
Uint8Array.prototype.set = function (value, offset) {
	copiedBytes += value.length;
	return originalSet.call(this, value, offset);
};
Uint8Array.prototype.slice = function (start, end) {
	const result = originalSlice.call(this, start, end);
	copiedBytes += result.length;
	return result;
};
const assembler = createRecordAssembler();
let assembled;
try {
	for (const piece of pieces) {
		for (const fullRecord of assembler.push(piece)) assembled = fullRecord;
	}
} finally {
	Uint8Array.prototype.set = originalSet;
	Uint8Array.prototype.slice = originalSlice;
}
assert.deepEqual(assembled, record);
assert.equal(copiedBytes, 1_179_704);
console.log(JSON.stringify({
	proof: 'actual assembler copy count',
	inputBytes: record.length,
	pieceBytes: pieces.map(piece => piece.length),
	copiedBytes,
	copyRatio: copiedBytes / record.length
}));

// Synthetic time schedule through the real controller API. This is not a browser trace.
// Sixteen chunks finish at 0, 10, ..., 150 ms. The first 1 MiB ACK arrives at 40 ms.
// The current sender structure consumes it only after its 4 MiB window fills.
const timely = createSendWindow();
const deferred = createSendWindow();
for (let chunk = 1; chunk <= 16; chunk++) {
	const offset = chunk * 256 * 1024;
	const at = (chunk - 1) * 10;
	timely.sent(offset, at);
	deferred.sent(offset, at);
	if (chunk === 4) timely.acked(1024 * 1024, 40);
}
deferred.acked(1024 * 1024, 160);
assert.equal(timely.snapshot().minRTT, 10);
assert.equal(deferred.snapshot().minRTT, 130);
console.log(JSON.stringify({
	proof: 'synthetic ACK schedule through actual controller',
	ackArrivalMs: 40,
	timelyRttMs: timely.snapshot().minRTT,
	deferredRttMs: deferred.snapshot().minRTT
}));
