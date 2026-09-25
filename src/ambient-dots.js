const SPACING = 16;
const REACH = 115;
const PUSH = 11;
const EASING = 0.18;

export function startAmbientDots() {
  const canvas = document.getElementById('ambient-dots');
  const context = canvas?.getContext('2d');
  if (!context) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let dots = [];
  let pointer = null;
  let frame = 0;
  let width = 0;
  let height = 0;

  function paint() {
    context.clearRect(0, 0, width, height);
    let moving = false;

    for (const dot of dots) {
      let targetX = 0;
      let targetY = 0;
      let glow = false;

      if (pointer && !reducedMotion.matches) {
        const dx = dot.x - pointer.x;
        const dy = dot.y - pointer.y;
        const distance = Math.hypot(dx, dy);
        if (distance < REACH) {
          const strength = (1 - distance / REACH) ** 2;
          const shift = strength * PUSH / (distance || 1);
          targetX = dx * shift;
          targetY = dy * shift;
          glow = strength > 0.08;
        }
      }

      dot.offsetX += (targetX - dot.offsetX) * EASING;
      dot.offsetY += (targetY - dot.offsetY) * EASING;
      if (Math.abs(targetX - dot.offsetX) < 0.06) dot.offsetX = targetX;
      else moving = true;
      if (Math.abs(targetY - dot.offsetY) < 0.06) dot.offsetY = targetY;
      else moving = true;

      context.fillStyle = glow ? 'rgba(229, 138, 87, .72)' : 'rgba(229, 95, 48, .34)';
      context.fillRect(dot.x + dot.offsetX, dot.y + dot.offsetY, 1.5, 1.5);
    }

    return moving;
  }

  function tick() {
    frame = 0;
    if (paint()) frame = requestAnimationFrame(tick);
  }

  function schedule() {
    if (!frame && !document.hidden) frame = requestAnimationFrame(tick);
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    dots = [];
    for (let y = SPACING / 2; y < height; y += SPACING) {
      for (let x = SPACING / 2; x < width; x += SPACING) {
        dots.push({ x, y, offsetX: 0, offsetY: 0 });
      }
    }
    paint();
    if (pointer && !reducedMotion.matches) schedule();
  }

  window.addEventListener('pointermove', (event) => {
    if (reducedMotion.matches || event.pointerType === 'touch') return;
    pointer = event.clientY < height ? { x: event.clientX, y: event.clientY } : null;
    schedule();
  }, { passive: true });
  window.addEventListener('pointerout', (event) => {
    if (event.relatedTarget) return;
    pointer = null;
    schedule();
  });
  window.addEventListener('blur', () => {
    pointer = null;
    schedule();
  });
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pointer = null;
      cancelAnimationFrame(frame);
      frame = 0;
    } else {
      schedule();
    }
  });
  reducedMotion.addEventListener('change', () => {
    pointer = null;
    for (const dot of dots) {
      dot.offsetX = 0;
      dot.offsetY = 0;
    }
    paint();
  });

  resize();
}
