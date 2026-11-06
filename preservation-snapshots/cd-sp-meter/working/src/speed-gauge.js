import {
  createRateMeter,
  createScale,
  formatBytes,
  formatEta,
  formatRate,
  formatRateText,
  formatScaleLabel,
  formatSummary,
  gaugeFraction
} from './speedometer.js';

// The live speed dial shown under every transfer's progress bar. Progress
// reports only feed the rate meter (cheap, any frequency); the dial paints
// itself a few times a second while bytes move, writes only what changed,
// and animates nothing but the needle's transform. It stops painting once
// the reading settles, so an idle or hidden gauge costs nothing.

const PAINT_MS = 250;
const ARIA_MS = 1000;
// Below this a stalled reading shows "–" instead of a crawl toward zero.
const STALL_FLOOR = 0.05 * 1024 * 1024;
// A stall this long gets a plain-language note under the numbers.
const WAITING_NOTE_MS = 5000;

// Dial geometry in SVG units; style.css mirrors CY / HEIGHT for the
// rotating needle and peak overlays.
const WIDTH = 160;
const HEIGHT = 124;
const CX = 80;
const CY = 74;
const SWEEP = 240;
const TICKS = 40;

// Lit ticks run from deep ember to the accent along the dial.
function emberAt(fraction) {
  const mix = 0.35 + 0.65 * fraction;
  const from = [0x6b, 0x2f, 0x1c];
  const to = [0xe5, 0x8a, 0x57];
  return `#${from.map((value, index) => Math.round(value + (to[index] - value) * mix).toString(16).padStart(2, '0')).join('')}`;
}

function point(degrees, radius) {
  const radians = (degrees * Math.PI) / 180;
  return [(CX + radius * Math.sin(radians)).toFixed(2), (CY - radius * Math.cos(radians)).toFixed(2)];
}

const FACE = (() => {
  const parts = [];
  const [ax, ay] = point(-SWEEP / 2, 48);
  const [bx, by] = point(SWEEP / 2, 48);
  parts.push(`<path class="gauge-track" d="M${ax} ${ay}A48 48 0 1 1 ${bx} ${by}"/>`);
  for (let index = 0; index <= TICKS; index += 1) {
    const major = index % 10 === 0;
    const degrees = -SWEEP / 2 + (SWEEP * index) / TICKS;
    const [x1, y1] = point(degrees, major ? 52 : 56);
    const [x2, y2] = point(degrees, 64);
    parts.push(`<line class="gauge-tick${major ? ' major' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${emberAt(index / TICKS)}"/>`);
  }
  return `<svg class="gauge-face" viewBox="0 0 ${WIDTH} ${HEIGHT}" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
})();

const MARKUP = `
  <div class="gauge-dial" role="meter" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0" aria-valuetext="not moving yet">
    ${FACE}
    <span class="gauge-peak" aria-hidden="true" hidden></span>
    <span class="gauge-needle" aria-hidden="true"></span>
    <span class="gauge-readout" aria-hidden="true">
      <span class="gauge-kicker">speed</span>
      <strong class="gauge-value">–</strong>
      <span class="gauge-unit">MB/s</span>
    </span>
    <span class="gauge-min" aria-hidden="true">0</span>
    <span class="gauge-max" aria-hidden="true">1 MB/s</span>
  </div>
  <div class="gauge-side">
    <dl class="gauge-stats">
      <div><dt>moved</dt><dd data-gauge="moved">–</dd></div>
      <div><dt>left</dt><dd data-gauge="left">–</dd></div>
      <div><dt>peak</dt><dd data-gauge="peak">–</dd></div>
      <div><dt>avg</dt><dd data-gauge="avg">–</dd></div>
    </dl>
    <p class="gauge-note"><span class="gauge-route" hidden></span><span class="gauge-wait"></span></p>
  </div>`;

const ROUTE_LABELS = { direct: 'direct', relay: 'relay' };

// mountSpeedGauge renders the dial into `host` and returns its controls:
// update(bytes, total, { route }) on every progress report (a report of 0
// bytes starts a new transfer; reaching `total` finishes it), setRoute()
// for the path label ("direct" / "relay", or "" to hide it), summary() for
// the finish line, and reset().
export function mountSpeedGauge(host, { label = 'Transfer speed' } = {}) {
  host.classList.add('speed-gauge');
  host.innerHTML = MARKUP;
  const dial = host.querySelector('.gauge-dial');
  dial.setAttribute('aria-label', label);
  const refs = {
    needle: host.querySelector('.gauge-needle'),
    peak: host.querySelector('.gauge-peak'),
    kicker: host.querySelector('.gauge-kicker'),
    value: host.querySelector('.gauge-value'),
    unit: host.querySelector('.gauge-unit'),
    max: host.querySelector('.gauge-max'),
    moved: host.querySelector('[data-gauge="moved"]'),
    left: host.querySelector('[data-gauge="left"]'),
    peakText: host.querySelector('[data-gauge="peak"]'),
    avg: host.querySelector('[data-gauge="avg"]'),
    route: host.querySelector('.gauge-route'),
    wait: host.querySelector('.gauge-wait')
  };
  const ticks = Array.from(host.querySelectorAll('.gauge-tick'));
  const meter = createRateMeter();
  const scale = createScale();
  // Last written values, so a paint touches only what changed.
  let shown = {};
  let litTicks = 0;
  let total = 0;
  let timer = 0;
  let lastPaint = -Infinity;
  let lastAria = -Infinity;
  let paintedReport = null;

  function setText(key, text) {
    if (shown[key] === text) return;
    shown[key] = text;
    refs[key].textContent = text;
  }

  function rotate(key, element, degrees) {
    if (shown[key] !== undefined && Math.abs(shown[key] - degrees) < 0.2) return;
    shown[key] = degrees;
    element.style.transform = `rotate(${degrees.toFixed(1)}deg)`;
  }

  function angle(fraction) {
    return -SWEEP / 2 + SWEEP * fraction;
  }

  function schedule() {
    if (timer) return;
    const wait = Math.max(0, PAINT_MS - (performance.now() - lastPaint));
    timer = setTimeout(paint, wait);
  }

  function paint() {
    timer = 0;
    const at = performance.now();
    lastPaint = at;
    const done = meter.finishedAt !== null;
    const moved = meter.bytes;
    const current = meter.rate(at);
    const stalled = !done && meter.overdue(at) > 0;
    // The finished dial rests on the average; a live one shows nothing
    // until a reading is a second old, and "–" once a stall bottoms out.
    const showing = done ? moved > 0 : meter.warm(at) && !(stalled && current < STALL_FLOOR);
    const rate = done ? meter.average(at) : current;
    const max = scale.update(rate, at);
    const reading = formatRate(rate);

    setText('kicker', done ? 'average' : 'speed');
    setText('value', showing ? reading.value : '–');
    setText('unit', showing ? reading.unit : 'MB/s');
    setText('max', formatScaleLabel(max));

    const fraction = showing ? gaugeFraction(rate, max) : 0;
    rotate('needle', refs.needle, angle(fraction));
    const lit = showing ? Math.round(fraction * TICKS) + 1 : 0;
    for (let index = Math.min(lit, litTicks); index < Math.max(lit, litTicks); index += 1) {
      ticks[index].classList.toggle('on', index < lit);
    }
    litTicks = lit;
    const peak = meter.peak;
    if (peak > 0) {
      if (refs.peak.hidden) refs.peak.hidden = false;
      rotate('peakAngle', refs.peak, angle(gaugeFraction(peak, max)));
    }

    setText('moved', total > 0 ? `${formatBytes(moved)} / ${formatBytes(total)}` : '–');
    const timeLeft = done ? 'done'
      : showing && meter.sampleCount >= 3 && rate > 0 ? formatEta((total - moved) / rate) : '–';
    setText('left', timeLeft);
    setText('peakText', peak > 0 ? formatRateText(peak) : '–');
    setText('avg', done || meter.warm(at) ? formatRateText(meter.average(at)) : '–');
    setText('wait', stalled && meter.overdue(at) > WAITING_NOTE_MS ? 'waiting for the other device…' : '');

    // Screen readers read the meter when they reach it; nothing announces
    // on its own, and the value changes at most once a second.
    if (done || at - lastAria >= ARIA_MS) {
      lastAria = at;
      const mib = (value) => (value / (1024 * 1024)).toFixed(1);
      dial.setAttribute('aria-valuemax', mib(max));
      dial.setAttribute('aria-valuenow', mib(Math.min(rate, max)));
      dial.setAttribute('aria-valuetext', showing ? `${done ? 'average ' : ''}${formatRateText(rate)}` : 'not moving yet');
    }

    // Keep painting while the reading can still change on its own: while
    // bytes flow, while a stall decays, and until the note shows.
    const report = meter.lastReportAt;
    const settled = report === paintedReport && (current === 0 || moved === 0) && (shown.wait !== '' || !stalled);
    paintedReport = report;
    if (!done && !settled) schedule();
  }

  function start(at) {
    meter.start(at);
    scale.reset();
    if (timer) clearTimeout(timer);
    timer = 0;
    paintedReport = null;
    refs.peak.hidden = true;
    delete shown.peakAngle;
  }

  function setRoute(route) {
    const text = ROUTE_LABELS[route] ? `via ${ROUTE_LABELS[route]}` : '';
    if (shown.route === text) return;
    shown.route = text;
    refs.route.textContent = text;
    refs.route.hidden = text === '';
  }

  return {
    update(bytes, totalBytes, { route } = {}) {
      const at = performance.now();
      const count = Number(bytes);
      if (meter.startedAt === null || count === 0 || count < meter.bytes) start(at);
      total = Number(totalBytes);
      meter.record(count, at);
      if (route !== undefined) setRoute(route);
      if (count >= total && meter.finishedAt === null) {
        meter.finish(at);
        paint();
        return;
      }
      schedule();
    },
    setRoute,
    // summary is the finish line, e.g. "1.20 GB in 41 s · avg 29.8 MB/s".
    summary() {
      if (meter.startedAt === null) return '';
      const end = meter.finishedAt ?? meter.lastReportAt;
      return formatSummary(meter.bytes, (end - meter.startedAt) / 1000);
    },
    reset() {
      start(performance.now());
      total = 0;
      setRoute('');
      paint();
    }
  };
}
