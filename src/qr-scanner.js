// Camera QR scanning: the browser's BarcodeDetector where it exists (fast,
// native), otherwise jsQR on downscaled frames. The page owns the <video>
// and its layout; this module only feeds it and reads codes from it.

const SCAN_INTERVAL_MS = 120;
// jsQR cost grows with pixels; 720px on the long edge still reads a QR that
// fills a fraction of the frame.
const MAX_DECODE_EDGE = 720;

async function nativeDetector() {
  if (typeof globalThis.BarcodeDetector !== 'function') return null;
  try {
    const formats = await globalThis.BarcodeDetector.getSupportedFormats?.();
    if (formats && !formats.includes('qr_code')) return null;
    const detector = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
    return async (video) => (await detector.detect(video))[0]?.rawValue || '';
  } catch {
    return null;
  }
}

async function canvasDetector() {
  const module = await import('jsqr');
  const jsQR = module.default || module;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return '';
    const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(width, height));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data || '';
  };
}

// startQrScanner shows the camera in video and calls onResult(text) for
// each decoded QR until onResult returns true or stop() is called.
export async function startQrScanner(video, onResult) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera unavailable');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
  });
  let stopped = false;
  let timer = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
  try {
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    const detect = (await nativeDetector()) || (await canvasDetector());
    const tick = async () => {
      if (stopped) return;
      let text = '';
      try { text = await detect(video); } catch { /* A dropped frame is fine. */ }
      if (stopped) return;
      if (text && onResult(text) === true) {
        stop();
        return;
      }
      timer = setTimeout(tick, SCAN_INTERVAL_MS);
    };
    void tick();
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
