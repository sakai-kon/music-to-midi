export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function midiNoteName(pitch) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return names[pitch % 12] + (Math.floor(pitch / 12) - 1);
}

export function encodeVariableLength(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new RangeError("MIDI delta time must be an integer between 0 and 0x0FFFFFFF.");
  }

  let buffer = value & 0x7f;
  const bytes = [];
  while ((value >>= 7) > 0) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }

  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) {
      buffer >>= 8;
    } else {
      break;
    }
  }
  return bytes;
}

function uint32(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ];
}

export function buildMidi(notes, bpm, numerator, denominator) {
  if (!Number.isFinite(bpm) || bpm < 1 || bpm > 1000) {
    throw new RangeError("BPM must be a finite value between 1 and 1000.");
  }
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 255) {
    throw new RangeError("Time signature numerator must be an integer between 1 and 255.");
  }
  if (![1, 2, 4, 8, 16, 32, 64, 128].includes(denominator)) {
    throw new RangeError("Unsupported MIDI time signature denominator.");
  }
  if (!Array.isArray(notes)) {
    throw new TypeError("MIDI notes must be an array.");
  }

  const ticksPerBeat = 480;
  const ticksPerSecond = ticksPerBeat * bpm / 60;
  const microsPerBeat = Math.round(60000000 / bpm);
  const denominatorPower = Math.round(Math.log2(denominator));
  const events = [
    {
      tick: 0,
      priority: -2,
      bytes: [
        0xff, 0x51, 0x03,
        (microsPerBeat >>> 16) & 255,
        (microsPerBeat >>> 8) & 255,
        microsPerBeat & 255
      ]
    },
    {
      tick: 0,
      priority: -1,
      bytes: [0xff, 0x58, 0x04, numerator, denominatorPower, 24, 8]
    }
  ];

  for (const note of notes) {
    const pitch = Number(note.pitch);
    const start = Number(note.start);
    const end = Number(note.end);
    const velocity = Number(note.velocity);

    if (
      !Number.isInteger(pitch) || pitch < 0 || pitch > 127 ||
      !Number.isFinite(start) || !Number.isFinite(end) ||
      end <= start || !Number.isFinite(velocity)
    ) {
      continue;
    }

    const startTick = Math.max(0, Math.round(start * ticksPerSecond));
    const endTick = Math.max(startTick + 1, Math.round(end * ticksPerSecond));
    events.push({
      tick: startTick,
      priority: 1,
      bytes: [0x90, pitch, Math.round(clamp(velocity, 1, 127))]
    });
    events.push({
      tick: endTick,
      priority: 0,
      bytes: [0x80, pitch, 0]
    });
  }

  events.sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  const track = [];
  let previousTick = 0;

  for (const event of events) {
    const delta = event.tick - previousTick;
    track.push(...encodeVariableLength(delta), ...event.bytes);
    previousTick = event.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);

  const trackBytes = new Uint8Array(track);
  const header = [
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (ticksPerBeat >>> 8) & 255,
    ticksPerBeat & 255,
    0x4d, 0x54, 0x72, 0x6b,
    ...uint32(trackBytes.length)
  ];

  return new Blob([new Uint8Array(header), trackBytes], { type: "audio/midi" });
}
