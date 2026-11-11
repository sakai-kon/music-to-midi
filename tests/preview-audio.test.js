import test from "node:test";
import assert from "node:assert/strict";
import { PREVIEW_TONES, getCanvasPixelRatio, getTimelineWidth, midiToFrequency, velocityGain } from "../src/preview-audio.js";

test("MIDI pitch 69 maps to concert A", () => {
  assert.equal(midiToFrequency(69), 440);
});

test("fractional MIDI pitch preserves microtonal pitch information", () => {
  assert.ok(midiToFrequency(69.5) > 440);
  assert.ok(midiToFrequency(69.5) < midiToFrequency(70));
});

test("velocity response is quiet at zero and increases smoothly", () => {
  assert.equal(velocityGain(0), 0);
  assert.ok(velocityGain(64) > 0);
  assert.ok(velocityGain(127) > velocityGain(64));
  assert.ok(velocityGain(127) <= 0.14);
});

test("each preview tone has a fundamental and useful upper harmonics", () => {
  for (const partials of Object.values(PREVIEW_TONES)) {
    assert.ok(partials.length >= 6);
    assert.equal(partials[0], 1);
    assert.ok(partials.slice(1).some((value) => value > 0));
  }
});

test("timeline width scales with duration and zoom without exceeding canvas limits", () => {
  const fit = getTimelineWidth(10, 600, 0.5);
  const zoomed = getTimelineWidth(10, 600, 2);
  assert.ok(zoomed > fit);
  assert.ok(getTimelineWidth(180, 360, 5) <= 16000);
  assert.ok(getTimelineWidth(3, 900, 1) >= 900);
});

test("canvas resolution adapts to large piano rolls to protect mobile memory", () => {
  const compactRatio = getCanvasPixelRatio(500, 300, 2);
  const largeRatio = getCanvasPixelRatio(16000, 1000, 2);
  assert.equal(compactRatio, 2);
  assert.ok(largeRatio < 1);
  assert.ok(16000 * 1000 * largeRatio * largeRatio <= 8000000 + 1);
  assert.throws(() => getCanvasPixelRatio(0, 100, 2), RangeError);
});

test("invalid audio preview values are rejected", () => {
  assert.throws(() => midiToFrequency(128), RangeError);
  assert.throws(() => velocityGain(-1), RangeError);
  assert.throws(() => getTimelineWidth(-1, 300, 1), RangeError);
});
