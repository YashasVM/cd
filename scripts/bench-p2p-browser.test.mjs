import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPayloadRoute, routeObserved, summarize } from './bench-p2p-browser.mjs';

test('ICE route classification requires observed selected candidates, not requested settings', () => {
  assert.equal(routeObserved({ peers: [{ states: ['connected'] }] }), 'unconfirmed');
  const peer = (localType, remoteType) => ({ selectedPairs: [{ localType, remoteType }] });
  assert.equal(routeObserved({ peers: [peer('host', 'srflx')] }), 'direct-webrtc');
  assert.equal(routeObserved({ peers: [peer('host', 'relay')] }), 'turn');
  assert.equal(routeObserved({ peers: [peer('host', 'relay'), peer('host', 'host')] }), 'mixed-ice');
  assert.equal(routeObserved({ peers: [peer('unknown', 'unknown')] }), 'unconfirmed');
});

test('payload route associates byte counts and selected ICE with the same connection', () => {
  const peer = (localType, remoteType, sent = 0, received = 0) => ({ selectedPairs: [{ localType, remoteType }], dataChannelSentBytes: sent, dataChannelReceivedBytes: received });
  const directControl = peer('host', 'host', 128, 64), turnPayload = peer('relay', 'srflx', 1048600);
  const stats = { peers: [directControl, turnPayload], dataChannelSentBytes: 1048728 };
  assert.equal(routeObserved(stats), 'mixed-ice');
  assert.equal(classifyPayloadRoute(stats, 1048576), 'turn');
  assert.equal(classifyPayloadRoute({ peers: [peer('host', 'host', 0, 1048600), peer('relay', 'host', 100)] }, 1048576), 'direct-webrtc');
  assert.equal(classifyPayloadRoute({ peers: [directControl], dataChannelSentBytes: 1048576 }, 1048576), 'unconfirmed');
  assert.equal(classifyPayloadRoute({ peers: [peer('host', 'host'), peer('relay', 'host', 100)] }, 1048576), 'unconfirmed');
  assert.equal(classifyPayloadRoute({ peers: [peer('host', 'host', 1048600), turnPayload] }, 1048576), 'mixed-ice');
  assert.equal(classifyPayloadRoute({ peers: [turnPayload] }, undefined), 'unconfirmed');
});

function fixture(runs = 5) {
  const input = { bytes: 1048576, sha256: 'a'.repeat(64) };
  return { runs, input, rows: ['cd', 'toffeeshare'].flatMap(tool => Array.from({ length: runs }, (_, run) => ({ tool, run, ok: true, readyMs: 10, receiveMs: tool === 'cd' ? 10 : 20, totalMs: tool === 'cd' ? 20 : 30, received: { ...input }, route: 'direct-webrtc' }))) };
}
test('only complete hash-verified repetitions produce scoped ratios, never worldwide claims', () => {
  const result = summarize(fixture());
  assert.equal(result.complete, true); assert.equal(result.repeatedComparison, true);
  assert.equal(result.toffeeOverCd.receiveMs, 2); assert.equal(result.fastestWorldwideProven, false);
  assert.equal(summarize(fixture(1)).repeatedComparison, false);
});
test('failed, missing, mismatched, duplicated and invalid rows suppress comparison', () => {
  for (const change of [report => report.rows.pop(), report => { report.rows[0].ok = false; }, report => { report.rows[0].received.bytes++; }, report => { report.rows[0].received.sha256 = 'b'.repeat(64); }, report => { report.rows[0].run = 1; }, report => { report.rows[0].receiveMs = NaN; }, report => { report.error = 'setup failed'; }, report => { report.interrupted = true; }]) {
    const report = fixture(); change(report); const result = summarize(report);
    assert.equal(result.complete, false); assert.equal(result.toffeeOverCd, null);
  }
  const report = fixture(); report.rows = report.rows.filter(row => row.tool === 'cd');
  assert.equal(summarize(report).tools.toffeeshare.status, 'not_run');
  const absentHashes = fixture(); delete absentHashes.input; absentHashes.rows.forEach(row => { delete row.received; });
  assert.equal(summarize(absentHashes).complete, false);
  const malformedHashes = fixture(); malformedHashes.input.sha256 = 'invalid'; malformedHashes.rows.forEach(row => { row.received.sha256 = 'invalid'; });
  assert.equal(summarize(malformedHashes).complete, false);
});
