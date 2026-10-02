// The relay sender's in-flight window adapts to the path: about two
// bandwidth-delay products (2 × delivery rate × minimum RTT), clamped. A fixed
// 8 MiB window over a 300 ms sender→relay→receiver loop caps throughput near
// 26 MiB/s. The maximum stays under the relay's 32 MiB per-peer buffer.
// Mirrors cmd/cdx/window.go.
export const MIN_SEND_WINDOW = 8 * 1024 * 1024;
export const MAX_SEND_WINDOW = 24 * 1024 * 1024;
// RATE_INTERVAL_MS is the shortest span a delivery-rate sample covers.
const RATE_INTERVAL_MS = 100;

export function createAdaptiveWindow() {
  let minRtt = 0;
  let samples = [];
  let markBytes = 0;
  let markTime = null;
  const window = {
    size: MIN_SEND_WINDOW,
    // sent records that bytes up to offset left the sender at time at (ms).
    sent(offset, at) {
      samples.push({ offset, sentAt: at });
    },
    // acked folds in an acknowledgement covering bytes, received at time at.
    acked(bytes, at) {
      let covered = -1;
      for (let index = 0; index < samples.length; index += 1) {
        if (samples[index].offset > bytes) break;
        covered = index;
      }
      if (covered >= 0) {
        const rtt = at - samples[covered].sentAt;
        if (rtt > 0 && (minRtt === 0 || rtt < minRtt)) minRtt = rtt;
        samples = samples.slice(covered + 1);
      }
      if (markTime === null) {
        markBytes = bytes;
        markTime = at;
        return;
      }
      const span = at - markTime;
      if (span < RATE_INTERVAL_MS || span < minRtt || minRtt === 0) return;
      const rate = (bytes - markBytes) / span;
      const target = Math.floor(2 * rate * minRtt);
      window.size = Math.min(Math.max(target, MIN_SEND_WINDOW), MAX_SEND_WINDOW);
      markBytes = bytes;
      markTime = at;
    }
  };
  return window;
}
