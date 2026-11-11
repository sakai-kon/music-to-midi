export const PREVIEW_TONES = Object.freeze({
  piano: Object.freeze([1, 0.48, 0.25, 0.13, 0.075, 0.04, 0.022, 0.012, 0.006]),
  soft: Object.freeze([1, 0.28, 0.12, 0.055, 0.025, 0.012, 0.005]),
  electric: Object.freeze([1, 0.22, 0.48, 0.16, 0.28, 0.08, 0.12, 0.035])
});

export function midiToFrequency(pitch) {
  const value = Number(pitch);
  if (!Number.isFinite(value) || value < 0 || value > 127) {
    throw new RangeError("MIDI pitch must be between 0 and 127.");
  }
  return 440 * Math.pow(2, (value - 69) / 12);
}

export function velocityGain(velocity) {
  const value = Number(velocity);
  if (!Number.isFinite(value) || value < 0 || value > 127) {
    throw new RangeError("MIDI velocity must be between 0 and 127.");
  }
  if (value === 0) return 0;
  return 0.14 * Math.pow(value / 127, 0.68);
}

export function getTimelineWidth(duration, viewportWidth, zoom = 1) {
  const seconds = Number(duration);
  const viewport = Number(viewportWidth);
  const scale = Number(zoom);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError("Duration must be a non-negative finite number.");
  }
  if (!Number.isFinite(viewport) || viewport <= 0) {
    throw new RangeError("Viewport width must be a positive finite number.");
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("Zoom must be a positive finite number.");
  }
  const pixelsPerSecond = 72 * Math.min(5, Math.max(0.06, scale));
  return Math.min(16000, Math.max(Math.ceil(viewport), Math.ceil(seconds * pixelsPerSecond + 84 + 18)));
}

export function getCanvasPixelRatio(width, height, devicePixelRatio = 1) {
  const canvasWidth = Number(width);
  const canvasHeight = Number(height);
  const deviceRatio = Number(devicePixelRatio);
  if (!Number.isFinite(canvasWidth) || canvasWidth <= 0 ||
      !Number.isFinite(canvasHeight) || canvasHeight <= 0 ||
      !Number.isFinite(deviceRatio) || deviceRatio <= 0) {
    throw new RangeError("Canvas dimensions and device pixel ratio must be positive finite numbers.");
  }
  const pixelBudgetRatio = Math.sqrt(8000000 / (canvasWidth * canvasHeight));
  return Math.max(0.5, Math.min(2, deviceRatio, pixelBudgetRatio));
}
