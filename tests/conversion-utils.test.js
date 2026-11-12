import test from "node:test";
import assert from "node:assert/strict";

import {
  clipNotesToDuration,
  validateConversionSettings
} from "../src/conversion-utils.js";

const validSettings = {
  tempoMode: "auto",
  bpm: "",
  numerator: "4",
  denominator: "4",
  sensitivity: "65",
  noiseReduction: "0"
};

test("conversion settings are validated and snapshotted as numbers", () => {
  const settings = validateConversionSettings(validSettings);
  assert.deepEqual(settings, {
    tempoMode: "auto",
    bpm: null,
    numerator: 4,
    denominator: 4,
    sensitivity: 65,
    noiseReduction: 0
  });
  assert.equal(Object.isFrozen(settings), true);
});

test("manual tempo must be inside the supported range", () => {
  assert.equal(validateConversionSettings({
    ...validSettings,
    tempoMode: "manual",
    bpm: "123.5"
  }).bpm, 123.5);
  for (const bpm of ["", "39.9", "240.1", "not-a-number"]) {
    assert.throws(
      () => validateConversionSettings({ ...validSettings, tempoMode: "manual", bpm }),
      RangeError
    );
  }
});

test("invalid time signature and processing ranges are rejected", () => {
  assert.throws(() => validateConversionSettings({ ...validSettings, numerator: "13" }), RangeError);
  assert.throws(() => validateConversionSettings({ ...validSettings, denominator: "3" }), RangeError);
  assert.throws(() => validateConversionSettings({ ...validSettings, sensitivity: "101" }), RangeError);
  assert.throws(() => validateConversionSettings({ ...validSettings, noiseReduction: "-1" }), RangeError);
});

test("notes are clipped to the source duration and invalid notes are discarded", () => {
  const notes = clipNotesToDuration([
    { pitch: 60, start: 0, end: 0.5, velocity: 90 },
    { pitch: 64, start: 2.8, end: 3.4, velocity: 80 },
    { pitch: 67, start: 3.1, end: 3.5, velocity: 80 },
    { pitch: 200, start: 0.2, end: 0.8, velocity: 80 },
    { pitch: 69, start: 1, end: 0.5, velocity: 80 }
  ], 3);

  assert.deepEqual(notes.map(({ pitch, start, end }) => ({ pitch, start, end })), [
    { pitch: 60, start: 0, end: 0.5 },
    { pitch: 64, start: 2.8, end: 3 }
  ]);
});

test("invalid note collections and durations are rejected", () => {
  assert.throws(() => clipNotesToDuration({}, 10), TypeError);
  assert.throws(() => clipNotesToDuration([], 0), RangeError);
});
