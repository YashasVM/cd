const MIB = 1024 * 1024;
export const MIN_SEND_WINDOW = 8 * MIB;
export const MAX_SEND_WINDOW = 24 * MIB;
const MAX_QUEUED_BYTES = 32 * MIB;
const RATE_INTERVAL_MS = 100;

// The adaptive window counts encrypted record bytes. Its 24 MiB cap and
// a separate check including the local socket queue protect 32 MiB peers.
export class SendWindow {
  size = MIN_SEND_WINDOW;
  minRTT = 0;
  sent = 0n;
  acknowledged = 0n;
  chunks = 0;
  inFlightBytes = 0;
  samples = [];
  markTime = null;
  markBytes = 0n;
  error = null;
  waiters = new Set();

  constructor() {
    this.failed = new Promise((_, reject) => { this.reject = reject; });
    void this.failed.catch(() => {});
  }

  // Call before handing the record to the transport: an ACK may arrive as
  // soon as send yields, including while another record is being encrypted.
  recordSent(bytes, recordBytes, at) {
    if (this.error) throw this.error;
    this.sent += BigInt(bytes);
    this.chunks += 1;
    this.inFlightBytes += recordBytes;
    this.samples.push({ offset: this.sent, at, recordBytes });
  }

  acknowledge({ chunks, bytes }, at) {
    if (chunks > this.chunks || bytes < this.acknowledged || bytes > this.sent) {
      throw new Error('The receiver sent invalid progress.');
    }
    this.acknowledged = bytes;
    let covered = 0;
    while (covered < this.samples.length && this.samples[covered].offset <= bytes) {
      this.inFlightBytes -= this.samples[covered].recordBytes;
      covered += 1;
    }
    if (covered > 0) {
      const rtt = at - this.samples[covered - 1].at;
      if (rtt > 0 && (this.minRTT === 0 || rtt < this.minRTT)) this.minRTT = rtt;
      this.samples.splice(0, covered);
    }
    if (this.markTime === null) {
      this.markTime = at;
      this.markBytes = bytes;
    } else {
      const span = at - this.markTime;
      if (span >= RATE_INTERVAL_MS && span >= this.minRTT && this.minRTT > 0) {
        const target = 2 * Number(bytes - this.markBytes) / span * this.minRTT;
        this.size = Math.min(MAX_SEND_WINDOW, Math.max(MIN_SEND_WINDOW, Math.floor(target)));
        this.markTime = at;
        this.markBytes = bytes;
      }
    }
    for (const wake of this.waiters) wake();
  }

  waitForSpace(recordBytes, bufferedAmount) {
    return this.waitUntil(() => {
      const outstanding = this.inFlightBytes + recordBytes;
      // bufferedAmount is already part of inFlightBytes. Count it again
      // only for the hard queue limit, not for the delivery-rate window.
      return outstanding <= this.size && outstanding + bufferedAmount() <= MAX_QUEUED_BYTES;
    }, bufferedAmount);
  }

  waitForAcknowledged() {
    return this.waitUntil(() => this.acknowledged === this.sent);
  }

  waitUntil(ready, bufferedAmount = () => 0) {
    return new Promise((resolve, reject) => {
      let timer;
      const wake = () => {
        clearTimeout(timer);
        if (this.error || ready()) {
          this.waiters.delete(wake);
          if (this.error) reject(this.error);
          else resolve();
        } else if (bufferedAmount() > 0) {
          // WebSocket has no bufferedamountlow event. ACKs wake this wait
          // immediately; poll only when local transport drainage can help.
          timer = setTimeout(wake, 8);
        }
      };
      this.waiters.add(wake);
      wake();
    });
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    this.reject(error);
    for (const wake of this.waiters) wake();
  }
}
