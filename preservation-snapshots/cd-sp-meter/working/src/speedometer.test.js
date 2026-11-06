import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SCALE_STEPS,
  createRateMeter,
  createScale,
  formatBytes,
  formatDuration,
  formatEta,
  formatRate,
  formatRateText,
  formatScaleLabel,
  formatSummary,
  gaugeFraction
} from './speedometer.js';

const MIB = 1024 * 1024;

// timeline turns phases of steady reports into [at, cumulative bytes]
// events: each phase reports `step` bytes every `every` ms until `until`.
// A phase with `from` starts after a silence.
function timeline(...phases) {
  const events = [];
  let at = 0;
  let bytes = 0;
  for (const { from = at, until, every, step } of phases) {
    for (let next = from + every; next <= until + 1e-9; next += every) {
      bytes += step;
      events.push([next, bytes]);
    }
    at = until;
  }
  return events;
}

// player replays events into the meter as time advances, so a reading at
// `at` only ever sees reports from before it, as in a live transfer.
function player(meter, events) {
  let cursor = 0;
  return (at) => {
    while (cursor < events.length && events[cursor][0] <= at) {
      meter.record(events[cursor][1], events[cursor][0]);
      cursor += 1;
    }
    return meter.rate(at);
  };
}

function started(at = 0) {
  const meter = createRateMeter();
  meter.start(at);
  return meter;
}

// readings samples a player every `every` ms over [from, until].
function readings(read, from, until, every = 7) {
  const values = [];
  for (let at = from; at <= until; at += every) values.push(read(at));
  return values;
}

function within(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= expected * tolerance,
    `${message}: ${(actual / MIB).toFixed(2)} MiB/s, expected ${(expected / MIB).toFixed(2)} ±${tolerance * 100}%`);
}

test('a steady per-chunk stream reads its true speed', () => {
  // 256 KiB every 10 ms = 25 MiB/s, the way a receiver reports chunks.
  const read = player(started(), timeline({ until: 4000, every: 10, step: 256 * 1024 }));
  for (const value of readings(read, 3000, 4000, 13)) within(value, 25 * MIB, 0.02, 'steady stream');
});

test('ACK-sized steps do not make the reading jitter between reports', () => {
  // A browser sender learns progress 1 MiB at a time: 10 MiB/s.
  const read = player(started(), timeline({ until: 8000, every: 100, step: MIB }));
  for (const value of readings(read, 3000, 8000)) within(value, 10 * MIB, 0.03, 'between ACKs');
});

test('ACKs that arrive in clumps still read the average speed', () => {
  // Three ACKs land together every 300 ms (the sender was busy sealing).
  const events = [];
  let bytes = 0;
  for (let at = 300; at <= 8000; at += 300) {
    for (let burst = 0; burst < 3; burst += 1) {
      bytes += MIB;
      events.push([at + burst, bytes]);
    }
  }
  const read = player(started(), events);
  for (const value of readings(read, 3500, 8000, 10)) within(value, 10 * MIB, 0.08, 'clumped ACKs');
});

test('slow one-MiB-per-second ACKs hold steady instead of pulsing', () => {
  const read = player(started(), timeline({ until: 12_000, every: 1000, step: MIB }));
  for (const value of readings(read, 4000, 12_000, 30)) within(value, MIB, 0.03, 'slow ACKs');
});

test('a jump in speed shows within two seconds', () => {
  const read = player(started(), timeline(
    { until: 5000, every: 20, step: 0.2 * MIB }, // 10 MiB/s
    { until: 9000, every: 20, step: MIB } // 50 MiB/s
  ));
  within(read(5000), 10 * MIB, 0.02, 'before the jump');
  // Share of the 10 -> 50 change the reading shows.
  const shown = (value) => (value - 10 * MIB) / (40 * MIB);
  assert.ok(shown(read(6000)) > 0.5, 'half the change after one second');
  assert.ok(shown(read(7000)) > 0.85, 'most of it after two seconds');
  within(read(8100), 50 * MIB, 0.02, 'settled after the window');
});

test('a drop in speed shows within two seconds', () => {
  const read = player(started(), timeline(
    { until: 5000, every: 20, step: MIB }, // 50 MiB/s
    { until: 9000, every: 20, step: 0.1 * MIB } // 5 MiB/s
  ));
  within(read(5000), 50 * MIB, 0.02, 'before the drop');
  const shown = (value) => (50 * MIB - value) / (45 * MIB);
  assert.ok(shown(read(6000)) > 0.5, 'half the change after one second');
  assert.ok(shown(read(7000)) > 0.85, 'most of it after two seconds');
  within(read(8100), 5 * MIB, 0.02, 'settled after the window');
});

test('a stall decays toward zero instead of freezing', () => {
  const meter = started();
  const read = player(meter, timeline({ until: 4000, every: 20, step: 0.4 * MIB })); // 20 MiB/s
  within(read(4000), 20 * MIB, 0.02, 'before the stall');
  assert.ok(meter.overdue(4000) < 0, 'on time');
  assert.ok(read(4250) > 0.98 * 20 * MIB, 'a short pause is not a stall');
  const values = readings(read, 4250, 8000, 50);
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(values[index] <= values[index - 1] + 1e-6, 'never rises while nothing arrives');
  }
  assert.ok(meter.overdue(4500) > 0, 'overdue');
  assert.ok(read(5000) < 0.75 * 20 * MIB, 'falling within a second');
  assert.ok(read(6000) < 0.25 * 20 * MIB, 'mostly gone within two seconds');
  assert.equal(read(7400), 0, 'zero once the window holds only silence');
});

test('a stall of a slow ACK-paced sender is noticed after a few missed reports', () => {
  const meter = started();
  const read = player(meter, timeline({ until: 6000, every: 1000, step: MIB }));
  within(read(6000), MIB, 0.02, 'before the stall');
  within(read(7900), MIB, 0.03, 'one late ACK is not a stall');
  assert.ok(read(10_000) < 0.5 * MIB, 'four missing ACKs are');
  assert.equal(read(11_500), 0);
});

test('one long stall does not slow the detection of the next', () => {
  const read = player(started(), timeline(
    { until: 3000, every: 20, step: 0.4 * MIB },
    { from: 8000, until: 12_000, every: 20, step: 0.4 * MIB }
  ));
  within(read(12_000), 20 * MIB, 0.02, 'after resuming');
  assert.ok(read(13_500) < 0.5 * 20 * MIB, 'second stall still reads within 1.5 s');
});

test('the opening burst does not spike the reading or the peak', () => {
  const meter = started();
  // A full 8 MiB window acknowledged almost at once, then 10 MiB/s.
  const read = player(meter, [[40, 8 * MIB], ...timeline({ from: 40, until: 8000, every: 100, step: MIB })
    .map(([at, bytes]) => [at, bytes + 8 * MIB])]);
  const values = readings(read, 0, 8000, 25);
  assert.ok(Math.max(...values) < 20 * MIB, `highest reading ${(Math.max(...values) / MIB).toFixed(1)} MiB/s`);
  assert.ok(meter.peak < 16 * MIB, `peak ${(meter.peak / MIB).toFixed(1)} MiB/s`);
  within(values.at(-1), 10 * MIB, 0.03, 'settles');
});

test('readings warm up for a second after the first byte', () => {
  const meter = started();
  const read = player(meter, timeline({ from: 2000, until: 6000, every: 20, step: 0.2 * MIB }));
  read(1500);
  assert.equal(meter.firstByteAt, null, 'connecting is not moving');
  assert.equal(meter.warm(1500), false);
  read(2500);
  assert.equal(meter.firstByteAt, 2020);
  assert.equal(meter.warm(2500), false);
  assert.equal(meter.peak, 0, 'young readings are not peaks');
  read(3100);
  assert.equal(meter.warm(3100), true);
  assert.ok(meter.peak > 0);
});

test('peak and average follow the transfer', () => {
  const meter = started(1000);
  const events = timeline(
    { from: 1000, until: 5000, every: 20, step: 0.6 * MIB }, // 30 MiB/s
    { until: 9000, every: 20, step: 0.2 * MIB } // 10 MiB/s
  );
  const read = player(meter, events);
  readings(read, 1000, 9000, 250);
  const bytes = events.at(-1)[1];
  within(meter.peak, 30 * MIB, 0.02, 'peak');
  within(meter.average(9000), 20 * MIB, 0.01, 'average while moving');
  meter.finish(9000);
  within(meter.average(60_000), 20 * MIB, 0.01, 'average stops at finish');
  assert.equal(meter.finishedAt, 9000);
  assert.equal(meter.bytes, bytes);
});

test('stale counts are ignored and samples stay bounded', () => {
  const meter = createRateMeter();
  meter.start(0);
  for (let at = 1; at <= 100_000; at += 1) meter.record(at * 1000, at);
  meter.record(5, 100_001);
  assert.equal(meter.bytes, 100_000 * 1000);
  assert.ok(meter.sampleCount <= 3000 / 50 + 3, `kept ${meter.sampleCount} samples`);
  within(meter.rate(100_000), 1000 * 1000, 0.02, 'one byte per microsecond');
});

test('start resets everything, and reports before any start begin one', () => {
  const meter = createRateMeter();
  assert.equal(meter.rate(0), 0);
  assert.equal(meter.average(0), 0);
  meter.record(0, 500);
  assert.equal(meter.startedAt, 500);
  readings(player(meter, timeline({ from: 500, until: 3000, every: 50, step: MIB })), 500, 3000, 100);
  assert.ok(meter.peak > 0);
  meter.finish(3000);
  meter.start(4000);
  assert.equal(meter.bytes, 0);
  assert.equal(meter.peak, 0);
  assert.equal(meter.finishedAt, null);
  assert.equal(meter.rate(4500), 0);
});

test('the scale grows at once and shrinks only after a quiet hold', () => {
  const scale = createScale();
  assert.equal(scale.max, SCALE_STEPS[0]);
  assert.equal(scale.update(30 * MIB, 0), 50 * MIB, 'jumps straight to a range with headroom');
  assert.equal(scale.update(45 * MIB, 100), 100 * MIB, 'grows past 80% of the dial');
  assert.equal(scale.update(20 * MIB, 3000), 100 * MIB, 'holds while the burst is recent');
  assert.equal(scale.update(20 * MIB, 6200), 50 * MIB, 'shrinks once the burst is 6 s old');
  assert.equal(scale.update(0, 20_000), 50 * MIB, 'a stall keeps the range');
});

test('a speed near a range boundary does not flip the range', () => {
  const scale = createScale();
  const seen = new Set();
  for (let at = 0; at < 30_000; at += 250) {
    seen.add(scale.update((at / 250) % 2 === 0 ? 3.9 * MIB : 4.1 * MIB, at));
  }
  assert.deepEqual([...seen], [5 * MIB, 10 * MIB], 'one step up, then stays');
});

test('the scale covers slow and very fast links', () => {
  const scale = createScale();
  assert.equal(scale.update(100 * 1024, 0), MIB);
  assert.equal(scale.update(1.5 * 1024 * MIB, 1), 2560 * MIB);
  assert.equal(scale.update(9 * 1024 * MIB, 2), 2560 * MIB, 'the top range is the ceiling');
  scale.reset();
  assert.equal(scale.max, MIB);
});

test('gaugeFraction clamps to the dial', () => {
  assert.equal(gaugeFraction(0, MIB), 0);
  assert.equal(gaugeFraction(-5, MIB), 0);
  assert.equal(gaugeFraction(NaN, MIB), 0);
  assert.equal(gaugeFraction(MIB / 4, MIB), 0.25);
  assert.equal(gaugeFraction(3 * MIB, MIB), 1);
});

test('rates use 1024-based KB/MB/GB like the size labels', () => {
  assert.deepEqual(formatRate(0), { value: '0', unit: 'KB/s' });
  assert.deepEqual(formatRate(NaN), { value: '0', unit: 'KB/s' });
  assert.deepEqual(formatRate(512), { value: '0.5', unit: 'KB/s' });
  assert.deepEqual(formatRate(300 * 1024), { value: '300', unit: 'KB/s' });
  assert.deepEqual(formatRate(1023.6 * 1024), { value: '1.0', unit: 'MB/s' });
  assert.deepEqual(formatRate(29.84 * MIB), { value: '29.8', unit: 'MB/s' });
  assert.deepEqual(formatRate(99.96 * MIB), { value: '100', unit: 'MB/s' });
  assert.deepEqual(formatRate(312.4 * MIB), { value: '312', unit: 'MB/s' });
  assert.deepEqual(formatRate(1.5 * 1024 * MIB), { value: '1.50', unit: 'GB/s' });
  assert.equal(formatRateText(29.84 * MIB), '29.8 MB/s');
  for (const rate of [1, 1000, 99_000, 1_000_000, 104_000_000, 1_070_000_000, 5e9]) {
    assert.ok(formatRate(rate).value.length <= 4, `${rate} fits the readout`);
  }
});

test('scale labels name each range exactly', () => {
  assert.deepEqual(SCALE_STEPS.map(formatScaleLabel), [
    '1 MB/s', '5 MB/s', '10 MB/s', '25 MB/s', '50 MB/s', '100 MB/s', '250 MB/s', '500 MB/s', '1 GB/s', '2.5 GB/s'
  ]);
  assert.equal(formatScaleLabel(256 * 1024), '256 KB/s');
});

test('durations and time left read naturally', () => {
  assert.equal(formatDuration(0.04), '<0.1 s');
  assert.equal(formatDuration(3.24), '3.2 s');
  assert.equal(formatDuration(41.2), '41 s');
  assert.equal(formatDuration(59.6), '1 min');
  assert.equal(formatDuration(125), '2 min 5 s');
  assert.equal(formatDuration(3780), '1 h 3 min');
  assert.equal(formatDuration(-1), '–');
  assert.equal(formatEta(0.4), '<1 s');
  assert.equal(formatEta(3.2), '4 s');
  assert.equal(formatEta(10), '10 s');
  assert.equal(formatEta(41.2), '45 s');
  assert.equal(formatEta(56), '1 min');
  assert.equal(formatEta(61), '2 min');
  assert.equal(formatEta(59 * 60 + 1), '1 h');
  assert.equal(formatEta(80 * 60), '1 h 20 min');
  assert.equal(formatEta(3 * 3600), '2 h+');
  assert.equal(formatEta(Infinity), '–');
  assert.equal(formatEta(-1), '–');
});

test('the finish line reads size, time, and average speed', () => {
  assert.equal(formatSummary(1.2 * 1024 * MIB, 41.2), '1.20 GB in 41 s · avg 29.8 MB/s');
  assert.equal(formatSummary(84.2 * MIB, 3.1), '84.2 MB in 3.1 s · avg 27.2 MB/s');
  assert.equal(formatSummary(0, 3), '');
  assert.equal(formatSummary(5, 0), '5 B in <0.1 s');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1.5 KB');
});
