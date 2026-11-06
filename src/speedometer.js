// Live transfer speed for the progress views. Progress arrives in uneven
// steps (a browser sender hears one ACK per MiB, receivers see every chunk),
// so a since-start average lags and per-step deltas jitter. createRateMeter
// reads the byte curve over the last few seconds instead, and createScale
// picks a dial range that fits it. Pure: callers pass timestamps in
// milliseconds, so tests drive a fake clock.

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

// Readings cover the last 3 s with the newest bytes weighted most: a change
// in speed shows within ~2 s, and old steps fade out instead of dropping off.
export const RATE_WINDOW_MS = 3000;
// The first second reads as if it were this long, so an opening burst does
// not spike the needle; readings that young are not shown or kept as peak.
export const WARMUP_MS = 1000;
// Reports closer together than this merge into one sample: per-chunk
// reports would otherwise keep thousands of points per window.
const SAMPLE_SPACING_MS = 50;
// Silence longer than about two usual report gaps is a stall and pulls the
// reading toward zero. The floor lets fast transfers react quickly; the cap
// stops slow, ACK-paced senders (one report per MiB) from pulsing between
// reports.
const MIN_GRACE_MS = 300;
const MAX_GRACE_MS = 10_000;

// createRateMeter tracks one transfer's cumulative byte count. record()
// takes every progress report; rate() is the current speed in bytes/s.
export function createRateMeter({ windowMs = RATE_WINDOW_MS } = {}) {
  let times = [];
  let counts = [];
  let startedAt = null;
  let finishedAt = null;
  let firstByteAt = null;
  let peak = 0;

  // Integral of the window weight (1 at `ref`, falling to 0 at
  // `ref - windowMs`) over [from, to].
  function weight(ref, from, to) {
    const early = ref - from;
    const late = ref - to;
    return (to - from) - (early * early - late * late) / (2 * windowMs);
  }

  function grace() {
    const gaps = [];
    for (let index = 1; index < times.length; index += 1) gaps.push(times[index] - times[index - 1]);
    gaps.sort((left, right) => left - right);
    const median = gaps.length > 0 ? gaps[gaps.length >> 1] : 0;
    return Math.min(MAX_GRACE_MS, Math.max(MIN_GRACE_MS, 2 * median));
  }

  function start(at) {
    times = [at];
    counts = [0];
    startedAt = at;
    finishedAt = null;
    firstByteAt = null;
    peak = 0;
  }

  function record(bytes, at) {
    if (startedAt === null) start(at);
    const last = times.length - 1;
    // Counts are cumulative; a smaller one is stale, not a rewind.
    if (!(bytes >= counts[last])) return;
    const when = Math.max(at, times[last]);
    if (firstByteAt === null && bytes > 0) firstByteAt = when;
    if (last >= 1 && when - times[last - 1] < SAMPLE_SPACING_MS) {
      times[last] = when;
      counts[last] = bytes;
    } else {
      times.push(when);
      counts.push(bytes);
    }
    // Keep one sample at or before the window's start to interpolate from.
    while (times.length > 2 && times[1] <= when - windowMs) {
      times.shift();
      counts.shift();
    }
  }

  // rate is the time-weighted speed over the window ending at the newest
  // report, or, once reports are overdue, at `at - grace`: the overdue time
  // counts as zero bytes, so a stall decays to 0 instead of freezing.
  function rate(at) {
    const count = times.length;
    if (startedAt === null || count < 2) return 0;
    const newest = times[count - 1];
    const ref = Math.max(newest, at - grace());
    const from = Math.max(ref - windowMs, startedAt);
    const span = Math.max(ref - from, Math.min(WARMUP_MS, windowMs));
    const total = weight(ref, ref - span, ref);
    let moved = 0;
    for (let index = count - 1; index > 0 && times[index] > from; index -= 1) {
      const bytes = counts[index] - counts[index - 1];
      if (bytes === 0) continue;
      const begin = times[index - 1];
      const end = times[index];
      if (end <= begin) {
        moved += bytes * (1 - (ref - end) / windowMs);
        continue;
      }
      // Bytes between two reports are spread evenly across the gap.
      moved += (bytes / (end - begin)) * weight(ref, Math.max(begin, from), end);
    }
    const value = total > 0 ? Math.max(0, (moved / total) * 1000) : 0;
    if (value > peak && warm(at)) peak = value;
    return value;
  }

  // warm: bytes have moved for long enough that a reading means something.
  function warm(at) {
    return firstByteAt !== null && at - firstByteAt >= WARMUP_MS;
  }

  return {
    start,
    record,
    rate,
    warm,
    // overdue is how long past the usual report gap the newest report is
    // (negative while reports are on time): above zero the meter is
    // reading a stall.
    overdue(at) {
      return startedAt === null ? -Infinity : at - times[times.length - 1] - grace();
    },
    // finish stops the clock for average(); the first call wins.
    finish(at) {
      if (startedAt !== null && finishedAt === null) finishedAt = Math.max(at, startedAt);
    },
    // average is bytes over the time since start (or until finish).
    average(at) {
      if (startedAt === null) return 0;
      const elapsed = (finishedAt ?? at) - startedAt;
      const bytes = counts[counts.length - 1];
      return elapsed > 0 && bytes > 0 ? (bytes / elapsed) * 1000 : 0;
    },
    get bytes() { return startedAt === null ? 0 : counts[counts.length - 1]; },
    get peak() { return peak; },
    get startedAt() { return startedAt; },
    get firstByteAt() { return firstByteAt; },
    get finishedAt() { return finishedAt; },
    get lastReportAt() { return startedAt === null ? null : times[times.length - 1]; },
    get sampleCount() { return times.length; }
  };
}

// Dial ranges in bytes/s. 1024-based like every size in CD, so the top two
// read "1 GB/s" and "2.5 GB/s" exactly.
export const SCALE_STEPS = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1024, 2560].map((mib) => mib * MIB));
// Grow as soon as the needle passes 80% of the dial; shrink only when every
// reading of the last 6 s fits under 60% of a smaller one. The gap between
// the two keeps a speed near a boundary from flipping the range.
const SCALE_GROW = 0.8;
const SCALE_SHRINK = 0.6;
const SCALE_HOLD_MS = 6000;

export function createScale({ steps = SCALE_STEPS, holdMs = SCALE_HOLD_MS } = {}) {
  let index = 0;
  // Sliding maximum of recent readings: [at, rate] pairs, rates decreasing.
  let recent = [];
  return {
    get max() { return steps[index]; },
    update(rate, at) {
      const value = Number.isFinite(rate) && rate > 0 ? rate : 0;
      while (recent.length > 0 && recent[recent.length - 1][1] <= value) recent.pop();
      recent.push([at, value]);
      while (recent[0][0] < at - holdMs) recent.shift();
      while (index < steps.length - 1 && value > steps[index] * SCALE_GROW) index += 1;
      // A stall keeps its range: the needle drops, the numbers stay put.
      if (value > 0) {
        const busiest = recent[0][1];
        let fit = 0;
        while (fit < index && busiest > steps[fit] * SCALE_SHRINK) fit += 1;
        index = fit;
      }
      return steps[index];
    },
    reset() {
      index = 0;
      recent = [];
    }
  };
}

// gaugeFraction is how far round the dial a rate sits, 0..1.
export function gaugeFraction(rate, max) {
  if (!(rate > 0) || !(max > 0)) return 0;
  return Math.min(rate / max, 1);
}

// formatBytes matches the size labels used across CD.
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (value < KIB) return `${value} B`;
  if (value < MIB) return `${(value / KIB).toFixed(1)} KB`;
  if (value < GIB) return `${(value / MIB).toFixed(1)} MB`;
  return `${(value / GIB).toFixed(2)} GB`;
}

// formatRate splits a speed into the dial's number and unit. At most four
// characters of number, so the readout never changes width much.
export function formatRate(bytesPerSecond) {
  const rate = Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? bytesPerSecond : 0;
  if (rate < 1023.5 * KIB) {
    const kb = rate / KIB;
    if (kb < 0.05) return { value: '0', unit: 'KB/s' };
    return { value: kb < 99.95 ? kb.toFixed(1) : Math.round(kb).toString(), unit: 'KB/s' };
  }
  if (rate < 1023.5 * MIB) {
    const mb = rate / MIB;
    return { value: mb < 99.95 ? mb.toFixed(1) : Math.round(mb).toString(), unit: 'MB/s' };
  }
  return { value: (rate / GIB).toFixed(2), unit: 'GB/s' };
}

export function formatRateText(bytesPerSecond) {
  const { value, unit } = formatRate(bytesPerSecond);
  return `${value} ${unit}`;
}

// formatScaleLabel names a dial range: "25 MB/s", "1 GB/s", "2.5 GB/s".
export function formatScaleLabel(bytesPerSecond) {
  const trim = (value) => String(Math.round(value * 10) / 10);
  if (bytesPerSecond >= GIB) return `${trim(bytesPerSecond / GIB)} GB/s`;
  if (bytesPerSecond >= MIB) return `${trim(bytesPerSecond / MIB)} MB/s`;
  return `${trim(bytesPerSecond / KIB)} KB/s`;
}

// formatDuration: "0.4 s", "3.2 s", "41 s", "2 min 5 s", "1 h 3 min".
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  if (seconds < 0.1) return '<0.1 s';
  if (seconds < 9.95) return `${seconds.toFixed(1)} s`;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  if (whole < 3600) {
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  const minutes = Math.round(whole / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// formatEta rounds time left up to coarse steps (1 s, then 5 s, then whole
// minutes) so it reads calmly and changes rarely; past two hours it is noise.
export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  if (seconds < 1) return '<1 s';
  if (seconds < 10) return `${Math.ceil(seconds)} s`;
  if (seconds < 55) return `${Math.ceil(seconds / 5) * 5} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 120) return minutes === 60 ? '1 h' : `1 h ${minutes - 60} min`;
  return '2 h+';
}

// formatSummary is the line shown when a transfer finishes:
// "1.20 GB in 41 s · avg 29.8 MB/s".
export function formatSummary(bytes, seconds) {
  if (!(bytes > 0)) return '';
  const moved = `${formatBytes(bytes)} in ${formatDuration(seconds)}`;
  if (!(seconds > 0)) return moved;
  return `${moved} · avg ${formatRateText(bytes / seconds)}`;
}
