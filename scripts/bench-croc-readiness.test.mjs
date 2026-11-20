import test from 'node:test';
import assert from 'node:assert/strict';
import { readinessObservation, sourceOrdering } from './bench-croc-readiness.mjs';

test('code display requires a complete invitation and registration requires the passive admission marker', () => {
  let now = 100;
  const row = readinessObservation('synthetic-code', () => now);
  now = 103; row.sender('On the other computer, run:\n  croc synthetic-');
  row.relay('client 127.0.0.1 connected\n');
  assert.equal(row.complete, false);
  assert.equal(row.result().codeDisplayedMs, null);
  now = 104; row.sender('code\n');
  assert.equal(row.result().codeDisplayedMs, 4);
  now = 108; row.relay('room has first ');
  assert.equal(row.complete, false);
  now = 109; row.relay('peer\n');
  assert.equal(row.complete, true);
  assert.equal(row.result().roomRegisteredMs, 9);
  assert.equal(row.result().observedRegistrationAfterDisplayMs, 5);
});

test('receipt timestamps preserve scheduling inversions instead of inventing elapsed time', () => {
  let now = 50;
  const row = readinessObservation('synthetic-code', () => now);
  now = 53; row.relay('room has first peer\n');
  now = 55; row.sender('Code is: synthetic-code\n');
  assert.equal(row.result().observedRegistrationAfterDisplayMs, -2);
  now = 80; row.relay('room has first peer\n'); row.sender('Code is: synthetic-code\n');
  assert.equal(row.result().roomRegisteredMs, 3);
  assert.equal(row.result().codeDisplayedMs, 5);
});

test('missing observations stay null rather than producing a readiness success', () => {
  const row = readinessObservation('synthetic-code', () => 10);
  row.sender('unrelated sender message');
  row.relay('starting pipes\nroom has second peer\n');
  assert.equal(row.complete, false);
  assert.equal(row.result().observedRegistrationAfterDisplayMs, null);
});

const croc = [
  'func (c *Client) Send(files []FileInfo) error {',
  'fmt.Fprint(output, formatSendInstructions(c.Options.SharedSecret))',
  'c.setupLocalRelay()',
  'go func() { c.connectRelayControl() }()',
  '}',
  'func next() {}'
].join('\n');
const tcp = [
  'func clientCommunication() {',
  'admission := s.admitToRoom(room, c)',
  'if admission.created {',
  'err = sendAdmission("ok")',
  'log.Debug("room has first peer")',
  '}',
  '}'
].join('\n');

test('pinned source ordering proves display precedes both registrations and the passive marker follows admission', () => {
  const result = sourceOrdering(croc, tcp);
  assert.equal(result.instructionsLine, 2);
  assert.equal(result.localSetupLine, 3);
  assert.equal(result.remoteConnectLine, 4);
  assert.equal(result.roomAdmitLine, 2);
  assert.equal(result.admissionReplyLine, 4);
  assert.equal(result.passiveMarkerLine, 5);
  assert.throws(() => sourceOrdering(croc.replace('fmt.Fprint(output, formatSendInstructions(c.Options.SharedSecret))', ''), tcp), /ordering changed/);
  assert.throws(() => sourceOrdering(croc.replace('c.setupLocalRelay()', ''), tcp), /ordering changed/);
  assert.throws(() => sourceOrdering(croc, tcp.replace('log.Debug("room has first peer")', '')), /ordering changed/);
});
