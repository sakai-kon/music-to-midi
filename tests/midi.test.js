import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMidi,
  encodeVariableLength,
  midiNoteName
} from "../src/midi.js";

function readAscii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

test("variable-length MIDI delta values use standard encoding", () => {
  assert.deepEqual(encodeVariableLength(0), [0x00]);
  assert.deepEqual(encodeVariableLength(127), [0x7f]);
  assert.deepEqual(encodeVariableLength(128), [0x81, 0x00]);
  assert.deepEqual(encodeVariableLength(16383), [0xff, 0x7f]);
  assert.deepEqual(encodeVariableLength(16384), [0x81, 0x80, 0x00]);
});

test("variable-length MIDI encoder rejects invalid deltas", () => {
  assert.throws(() => encodeVariableLength(-1), RangeError);
  assert.throws(() => encodeVariableLength(0x10000000), RangeError);
  assert.throws(() => encodeVariableLength(1.5), RangeError);
});

test("MIDI note labels use standard middle-C numbering", () => {
  assert.equal(midiNoteName(60), "C4");
  assert.equal(midiNoteName(61), "C#4");
  assert.equal(midiNoteName(69), "A4");
  assert.equal(midiNoteName(0), "C-1");
});

test("buildMidi emits a valid single-track MIDI file with tempo and meter", async () => {
  const blob = buildMidi([
    { pitch: 60, start: 0, end: 0.5, velocity: 100 },
    { pitch: 64, start: 0, end: 0.5, velocity: 85 },
    { pitch: 67, start: 0.5, end: 1, velocity: 90 }
  ], 120, 4, 4);

  assert.equal(blob.type, "audio/midi");
  const bytes = new Uint8Array(await blob.arrayBuffer());

  assert.equal(readAscii(bytes, 0, 4), "MThd");
  assert.equal(new DataView(bytes.buffer).getUint32(4), 6);
  assert.equal(new DataView(bytes.buffer).getUint16(8), 0);
  assert.equal(new DataView(bytes.buffer).getUint16(10), 1);
  assert.equal(new DataView(bytes.buffer).getUint16(12), 480);
  assert.equal(readAscii(bytes, 14, 4), "MTrk");

  const trackLength = new DataView(bytes.buffer).getUint32(18);
  assert.equal(trackLength, bytes.length - 22);

  const track = bytes.slice(22);
  assert.deepEqual(Array.from(track.slice(0, 6)), [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1
  ]);
  assert.deepEqual(Array.from(track.slice(6, 13)), [
    0x20, 0x00, 0xff, 0x58, 0x04, 0x04, 0x02
  ]);
  assert.deepEqual(Array.from(track.slice(13, 15)), [0x18, 0x08]);

  assert.ok(track.includes(0x90), "track should contain note-on events");
  assert.ok(track.includes(0x80), "track should contain note-off events");
  assert.deepEqual(Array.from(track.slice(-4)), [0x00, 0xff, 0x2f, 0x00]);
});

test("buildMidi filters malformed note records and rejects invalid meter data", async () => {
  const blob = buildMidi([
    { pitch: 60, start: 0, end: 1, velocity: 100 },
    { pitch: 200, start: 0, end: 1, velocity: 100 },
    { pitch: 64, start: Number.NaN, end: 1, velocity: 100 },
    { pitch: 67, start: 1, end: 1, velocity: 100 }
  ], 100, 3, 4);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(readAscii(bytes, 0, 4), "MThd");
  assert.throws(() => buildMidi([], Number.NaN, 4, 4), RangeError);
  assert.throws(() => buildMidi([], 120, 0, 4), RangeError);
  assert.throws(() => buildMidi([], 120, 4, 3), RangeError);
});
