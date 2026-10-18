import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransferActivity } from './transfer-activity.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeHost(request) {
  const handlers = new Map();
  return {
    document: {
      hidden: false,
      addEventListener(name, handler) { handlers.set(name, handler); },
      setHidden(hidden) {
        this.hidden = hidden;
        handlers.get('visibilitychange')();
      }
    },
    navigator: { wakeLock: { request } }
  };
}

test('one wake lock covers overlapping transfers and returns after visibility changes', async () => {
  let requests = 0;
  let releases = 0;
  const host = fakeHost(async (kind) => {
    assert.equal(kind, 'screen');
    requests += 1;
    return { async release() { releases += 1; } };
  });
  const activity = createTransferActivity(host);
  const states = [];
  activity.onActivityChange((active) => states.push(active));

  const stopFirst = activity.beginTransfer();
  const stopSecond = activity.beginTransfer();
  await settle();
  assert.equal(requests, 1);
  assert.deepEqual(states, [false, true]);

  host.document.setHidden(true);
  await settle();
  assert.equal(releases, 1);
  host.document.setHidden(false);
  await settle();
  assert.equal(requests, 2);

  stopFirst();
  assert.equal(releases, 1);
  stopSecond();
  stopSecond();
  await settle();
  assert.equal(releases, 2);
  assert.deepEqual(states, [false, true, false]);
});

test('late wake-lock grants release after cancellation', async () => {
  let grant;
  let releases = 0;
  const host = fakeHost(() => new Promise((resolve) => { grant = resolve; }));
  const activity = createTransferActivity(host);
  const stop = activity.beginTransfer();
  await settle();
  stop();
  grant({ async release() { releases += 1; } });
  await settle();
  assert.equal(releases, 1);
});

test('visibility return retries a pending request that was denied while hidden', async () => {
  let rejectFirst;
  let requests = 0;
  const host = fakeHost(() => {
    requests += 1;
    if (requests === 1) return new Promise((_, reject) => { rejectFirst = reject; });
    return Promise.resolve({ async release() {} });
  });
  const activity = createTransferActivity(host);
  const stop = activity.beginTransfer();
  await settle();
  host.document.setHidden(true);
  host.document.setHidden(false);
  rejectFirst(new Error('released while hidden'));
  await settle();
  assert.equal(requests, 2);
  stop();
});

test('missing or denied wake lock does not block transfer activity', async () => {
  const host = fakeHost(async () => { throw new Error('denied'); });
  const activity = createTransferActivity(host);
  const states = [];
  activity.onActivityChange((active) => states.push(active));
  const stop = activity.beginTransfer();
  await settle();
  stop();
  assert.deepEqual(states, [false, true, false]);

  delete host.navigator.wakeLock;
  const stopWithoutApi = activity.beginTransfer();
  stopWithoutApi();
  assert.deepEqual(states, [false, true, false, true, false]);
});
