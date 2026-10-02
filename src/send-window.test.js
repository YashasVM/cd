import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdaptiveWindow, MAX_SEND_WINDOW, MIN_SEND_WINDOW } from './send-window.js';

// simulate drives the window over a link of bandwidth (bytes/ms) and rtt (ms)
// and returns the window it settled on.
function simulate(bandwidth, rtt, total) {
  const window = createAdaptiveWindow();
  const chunk = 256 * 1024;
  const inFlight = [];
  let now = 0;
  let sent = 0;
  let acknowledged = 0;
  let wireFree = 0;
  while (acknowledged < total) {
    while (sent < total && sent - acknowledged < window.size) {
      sent += chunk;
      wireFree = Math.max(wireFree, now) + chunk / bandwidth;
      window.sent(sent, now);
      inFlight.push({ offset: sent, ackAt: wireFree + rtt });
    }
    const next = inFlight.shift();
    now = Math.max(now, next.ackAt);
    acknowledged = next.offset;
    window.acked(acknowledged, now);
  }
  return window.size;
}

test('slow links keep the minimum window', () => {
  assert.equal(simulate(1024, 50, 64 * 1024 * 1024), MIN_SEND_WINDOW);
});

test('fast long links grow the window to the cap', () => {
  assert.equal(simulate(100 * 1024, 300, 512 * 1024 * 1024), MAX_SEND_WINDOW);
});
