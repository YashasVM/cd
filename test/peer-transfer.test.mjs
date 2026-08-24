import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sendFiles } from '../src/peer-transfer.js';

class Connection extends EventEmitter {
  dataChannel = { bufferedAmount: 0 };
  sent = [];
  send(data) {
    this.sent.push(data);
    if (data?.type === 'transfer-complete') queueMicrotask(() => this.emit('data', { type: 'receipt' }));
  }
  close() { this.emit('close'); }
  off(name, handler) { this.removeListener(name, handler); }
}

const file = (name, text) => {
  const blob = new Blob([text], { type: 'text/plain' });
  return { name, type: blob.type, size: blob.size, slice: (...args) => blob.slice(...args) };
};

test('sender completes only after the receiver receipt', async () => {
  const connection = new Connection();
  const states = [];
  const result = await sendFiles(connection, [file('a.txt', 'hello')], { state: value => states.push(value) });
  assert.equal(result.ok, true);
  assert.deepEqual(connection.sent.filter(item => item?.type).map(item => item.type), [
    'manifest', 'file-start', 'file-complete', 'transfer-complete',
  ]);
  assert.equal(states.at(-1).phase, 'completed');
  assert.match(states.at(-2).message, /waiting for receiver/i);
});

test('sender reports an early connection close as a failure', async () => {
  const connection = new Connection();
  connection.send = function send(data) {
    this.sent.push(data);
    if (data?.type === 'transfer-complete') queueMicrotask(() => this.emit('close'));
  };
  const states = [];
  const result = await sendFiles(connection, [file('a.txt', 'hello')], { state: value => states.push(value) });
  assert.equal(result.ok, false);
  assert.equal(states.at(-1).phase, 'failed');
  assert.match(states.at(-1).message, /closed before/i);
});

test('sender exits backpressure when the connection closes', async () => {
  const connection = new Connection();
  connection.dataChannel.bufferedAmount = 9 * 1024 * 1024;
  const transfer = sendFiles(connection, [file('a.txt', 'hello')]);
  queueMicrotask(() => connection.emit('close'));
  const result = await Promise.race([
    transfer,
    new Promise((_, reject) => setTimeout(() => reject(new Error('transfer hung in backpressure')), 500)),
  ]);
  assert.equal(result.ok, false);
});
