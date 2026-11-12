import * as tf from "@tensorflow/tfjs";
import { loadBasicPitchGraphModel } from "./model-storage.js";
import { buildMidi, clamp, midiNoteName } from "./midi.js";
import { getCanvasPixelRatio, getTimelineWidth, midiToFrequency, PREVIEW_TONES, velocityGain } from "./preview-audio.js";
import {
  BasicPitch,
  addPitchBendsToNoteEvents,
  noteFramesToTime,
  outputToNotesPoly
} from "@spotify/basic-pitch";

const $ = (id) => document.getElementById(id);
const fileInput = $("fileInput");
const dropzone = $("dropzone");
const convertButton = $("convertButton");
const resultSection = $("resultSection");
const errorBox = $("errorMessage");
const progressPanel = $("progressPanel");
const canvas = $("pianoRoll");
const pianoViewport = $("pianoViewport");
const pianoStage = $("pianoStage");
const playheadCanvas = $("pianoPlayhead");

const TARGET_RATE = 22050;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_DURATION_SECONDS = 180;
const MODEL_URL = new URL(
  `${import.meta.env.BASE_URL}models/model.json`,
  window.location.origin
).href;

let selectedFile = null;
let isConverting = false;
let selectedObjectUrl = null;
let latestResult = null;
let pitchModel = null;
let audioContext = null;
let activeVoices = [];
let playbackBus = [];
let playbackFrame = 0;
let playbackStartAt = 0;
let pianoZoom = 1;
let pianoLayout = null;
let modelLoadPromise = null;

function setError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function clearError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}

function setProgress(percent, title, message) {
  progressPanel.classList.remove("hidden");
  $("progressTitle").textContent = title;
  $("progressPercent").textContent = Math.round(percent) + "%";
  $("progressMessage").textContent = message;
  const bar = progressPanel.querySelector(".progress-track span");
  const value = Math.max(0, Math.min(100, percent));
  bar.style.width = Math.max(2, value) + "%";
  progressPanel.querySelector(".progress-track")?.setAttribute("aria-valuenow", String(Math.round(value)));
}

function setBusy(busy) {
  isConverting = busy;
  convertButton.disabled = busy || !selectedFile;
  $("chooseFile").disabled = busy;
  $("removeFile").disabled = busy;
  fileInput.disabled = busy;
  dropzone.setAttribute("aria-busy", String(busy));
  $("convertButtonText").textContent = busy ? "解析しています..." : "MIDIに変換";
  if (busy) {
    progressPanel.classList.remove("hidden");
  } else {
    progressPanel.classList.add("hidden");
  }
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? Math.max(1, Math.round(bytes / 1024)) + " KB"
    : (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
}

function safeStem(name) {
  return (name || "transcription")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 70) || "transcription";
}

function setFile(file) {
  if (!file || isConverting) return;
  clearError();
  stopPlayback();

  if (file.size > MAX_FILE_BYTES) {
    clearFile();
    setError("ファイルは30 MB以内にしてください。");
    return;
  }
  if (file.size === 0) {
    clearFile();
    setError("空のファイルは選択できません。");
    return;
  }

  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  const allowed = [".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aiff", ".aif"];
  if (!allowed.includes(ext)) {
    clearFile();
    setError("MP3 / WAV / FLAC / M4A / OGG / AIFFに対応しています。");
    return;
  }

  selectedFile = file;
  latestResult = null;
  resultSection.classList.add("hidden");
  $("fileName").textContent = file.name;
  $("fileSize").textContent = formatBytes(file.size);
  $("fileInfo").classList.remove("hidden");
  dropzone.classList.add("compact");
  convertButton.disabled = false;

  if (selectedObjectUrl) URL.revokeObjectURL(selectedObjectUrl);
  selectedObjectUrl = URL.createObjectURL(file);
  $("audioPreview").src = selectedObjectUrl;
  $("audioPreviewWrap").classList.remove("hidden");
}

function clearFile() {
  stopPlayback();
  selectedFile = null;
  latestResult = null;
  resultSection.classList.add("hidden");
  fileInput.value = "";
  $("fileInfo").classList.add("hidden");
  $("audioPreviewWrap").classList.add("hidden");
  $("audioPreview").pause();
  $("audioPreview").removeAttribute("src");
  $("audioPreview").load();
  dropzone.classList.remove("compact");
  convertButton.disabled = true;

  if (selectedObjectUrl) URL.revokeObjectURL(selectedObjectUrl);
  selectedObjectUrl = null;
  clearError();
}

$("chooseFile").addEventListener("click", () => fileInput.click());
dropzone.addEventListener("click", (event) => {
  if (!event.target.closest("button")) fileInput.click();
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) setFile(file);
  // Reset so choosing the same file again still fires the change event.
  fileInput.value = "";
});
$("removeFile").addEventListener("click", clearFile);

["dragenter", "dragover"].forEach((type) => {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((type) => {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.remove("dragover");
  });
});
dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) setFile(file);
});

$("sensitivity").addEventListener("input", () => {
  $("sensitivityValue").textContent = $("sensitivity").value;
});
$("noiseReduction").addEventListener("input", () => {
  $("noiseValue").textContent = $("noiseReduction").value + "%";
});
$("tempoMode").addEventListener("change", () => {
  $("bpmInput").disabled = $("tempoMode").value !== "manual";
});

async function readMediaDuration(file) {
  const objectUrl = URL.createObjectURL(file);
  const media = new Audio();
  media.preload = "metadata";

  try {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(null), 8000);
      media.addEventListener("loadedmetadata", () => {
        finish(Number.isFinite(media.duration) ? media.duration : null);
      }, { once: true });
      media.addEventListener("error", () => finish(null), { once: true });
      media.src = objectUrl;
      media.load();
    });
  } finally {
    media.pause();
    media.removeAttribute("src");
    media.load();
    URL.revokeObjectURL(objectUrl);
  }
}

async function decodeAndResample(file) {
  const metadataDuration = await readMediaDuration(file);
  if (metadataDuration !== null && metadataDuration > MAX_DURATION_SECONDS) {
    throw new Error("音源は3分以内にしてください。");
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("このブラウザはWeb Audio APIに対応していません。");
  }

  const decodingContext = new AudioContextClass();
  try {
    const encoded = await file.arrayBuffer();
    const decoded = await decodingContext.decodeAudioData(encoded.slice(0));
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0.05) {
      throw new Error("音源が短すぎるか、正常に読み込めませんでした。");
    }
    if (decoded.duration > MAX_DURATION_SECONDS) {
      throw new Error("音源は3分以内にしてください。");
    }

    const mono = new Float32Array(decoded.length);
    const channelCount = decoded.numberOfChannels;
    for (let channel = 0; channel < channelCount; channel++) {
      const samples = decoded.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        mono[i] += samples[i] / channelCount;
      }
    }

    let resampled;
    if (decoded.sampleRate === TARGET_RATE) {
      resampled = mono;
    } else {
      const OfflineContextClass =
        window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (OfflineContextClass) {
        const targetLength = Math.ceil(decoded.duration * TARGET_RATE);
        const offline = new OfflineContextClass(1, targetLength, TARGET_RATE);
        const monoBuffer = offline.createBuffer(1, mono.length, decoded.sampleRate);
        monoBuffer.copyToChannel(mono, 0);
        const source = offline.createBufferSource();
        source.buffer = monoBuffer;
        source.connect(offline.destination);
        source.start(0);
        const rendered = await offline.startRendering();
        resampled = new Float32Array(rendered.getChannelData(0));
      } else {
        const targetLength = Math.ceil(mono.length * TARGET_RATE / decoded.sampleRate);
        resampled = new Float32Array(targetLength);
        const scale = decoded.sampleRate / TARGET_RATE;
        for (let i = 0; i < targetLength; i++) {
          const position = i * scale;
          const left = Math.floor(position);
          const right = Math.min(left + 1, mono.length - 1);
          const fraction = position - left;
          resampled[i] = mono[left] * (1 - fraction) + mono[right] * fraction;
        }
      }
    }

    return { samples: resampled, duration: decoded.duration };
  } finally {
    await decodingContext.close().catch(() => {});
  }
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function applyNoiseGate(samples, amount) {
  if (amount <= 0) return samples;
  const blockSize = 256;
  const rmsValues = [];
  for (let start = 0; start < samples.length; start += blockSize) {
    let sum = 0;
    const end = Math.min(samples.length, start + blockSize);
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    rmsValues.push(Math.sqrt(sum / Math.max(1, end - start)));
  }

  const noiseFloor = percentile(rmsValues, 0.12);
  const threshold = noiseFloor * (1.4 + amount / 100 * 3.5) + 0.000025;
  const output = new Float32Array(samples.length);
  let smoothGain = 1;
  const release = 0.12;
  const attack = 0.72;

  for (let block = 0; block < rmsValues.length; block++) {
    const level = rmsValues[block];
    let target = 1;
    if (level < threshold) {
      target = Math.max(0.025, level / Math.max(threshold, 1e-6));
    }
    const coefficient = target < smoothGain ? attack : release;
    smoothGain += (target - smoothGain) * coefficient;
    const start = block * blockSize;
    const end = Math.min(samples.length, start + blockSize);
    for (let i = start; i < end; i++) {
      output[i] = samples[i] * smoothGain;
    }
  }
  return output;
}

function detectTempo(samples) {
  const frameSize = 1024;
  const hop = 256;
  const envelope = [];
  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    let energy = 0;
    for (let i = start; i < start + frameSize; i++) {
      energy += samples[i] * samples[i];
    }
    envelope.push(Math.sqrt(energy / frameSize));
  }
  if (envelope.length < 30) return 120;

  const onset = new Float64Array(envelope.length);
  for (let i = 1; i < envelope.length; i++) {
    onset[i] = Math.max(0, envelope[i] - envelope[i - 1]);
  }
  const mean = onset.reduce((sum, value) => sum + value, 0) / onset.length;
  let noveltyEnergy = 0;
  for (let i = 0; i < onset.length; i++) {
    onset[i] = Math.max(0, onset[i] - mean);
    noveltyEnergy += onset[i];
  }
  // Silence or a near-constant sustained tone has no reliable beat pulse.
  if (noveltyEnergy < 1e-6) return 120;

  let bestBpm = 120;
  let bestScore = 0;
  const framesPerSecond = TARGET_RATE / hop;

  for (let bpm = 55; bpm <= 200; bpm += 0.5) {
    const lag = Math.round((60 / bpm) * framesPerSecond);
    if (lag < 2 || lag >= onset.length) continue;
    let score = 0;
    let weight = 0;
    for (let i = lag; i < onset.length; i++) {
      score += onset[i] * onset[i - lag];
      weight++;
    }
    score /= Math.max(1, weight);
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  return Math.round(bestBpm * 10) / 10;
}

async function ensureModel() {
  if (pitchModel) return pitchModel;
  if (modelLoadPromise) return modelLoadPromise;

  modelLoadPromise = (async () => {
    setProgress(7, "AIモデルを準備しています", "初回はモデルのダウンロードに少し時間がかかります。");
    const isIOSDevice =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    try {
      const preferredBackend = isIOSDevice ? "cpu" : "webgl";
      const backendAvailable = await tf.setBackend(preferredBackend);
      if (!backendAvailable) await tf.setBackend("cpu");
    } catch {
      await tf.setBackend("cpu");
    }
    await tf.ready();

    const graphModel = await loadBasicPitchGraphModel(tf, MODEL_URL, (status) => {
      if (status === "checking-cache") {
        setProgress(7, "保存済みAIモデルを確認しています", "この端末のブラウザ内ストレージを確認しています。");
      } else if (status === "downloading") {
        setProgress(7, "AIモデルを初回ダウンロードしています", "取得したモデルは端末内に保存し、次回から再ダウンロードを避けます。");
      } else if (status === "loaded-cache") {
        setProgress(14, "端末に保存したAIモデルを読み込みました", "ネットワークからモデルを再取得せずに準備できました。");
      } else if (status === "saved") {
        setProgress(14, "AIモデルを端末に保存しました", "次回からは保存済みモデルを優先して読み込みます。");
      } else if (status === "save-failed") {
        setProgress(14, "AIモデルを読み込みました", "端末内保存を利用できませんでした。次回は再ダウンロードが必要になる場合があります。");
      }
    });
    const model = new BasicPitch(Promise.resolve(graphModel));
    await model.model;
    pitchModel = model;
    return model;
  })();

  try {
    return await modelLoadPromise;
  } catch (error) {
    modelLoadPromise = null;
    throw error;
  }
}

async function transcribe(samples, sensitivity) {
  const model = await ensureModel();
  const frames = [];
  const onsets = [];
  const contours = [];
  const engine = tf.engine();
  engine.startScope();
  try {
    await model.evaluateModel(
      samples,
      (frameChunk, onsetChunk, contourChunk) => {
        frames.push(...frameChunk);
        onsets.push(...onsetChunk);
        contours.push(...contourChunk);
      },
      (fraction) => {
        const pct = 18 + fraction * 76;
        setProgress(
          pct,
          "ノートを推定しています",
          "Basic Pitchが音の立ち上がり・高さ・持続時間を解析しています。"
        );
      }
    );
  } finally {
    engine.endScope();
  };

  const onsetThreshold = 0.68 - sensitivity * 0.004;
  const frameThreshold = 0.48 - sensitivity * 0.0025;
  const minimumFrames = Math.round(8 - sensitivity * 0.055);
  const rawNotes = outputToNotesPoly(
    frames,
    onsets,
    clamp(onsetThreshold, 0.25, 0.8),
    clamp(frameThreshold, 0.15, 0.6),
    clamp(minimumFrames, 2, 8),
    true,
    null,
    null,
    true
  );
  const noteEvents = noteFramesToTime(
    addPitchBendsToNoteEvents(contours, rawNotes)
  );

  return noteEvents
    .filter((note) =>
      Number.isFinite(note.startTimeSeconds) &&
      Number.isFinite(note.durationSeconds) &&
      note.durationSeconds > 0 &&
      note.pitchMidi >= 0 &&
      note.pitchMidi <= 127
    )
    .map((note) => ({
      pitch: Math.round(note.pitchMidi),
      pitchFloat: clamp(note.pitchMidi, 0, 127),
      name: midiNoteName(Math.round(note.pitchMidi)),
      start: Math.max(0, note.startTimeSeconds),
      end: Math.max(note.startTimeSeconds + 0.025, note.startTimeSeconds + note.durationSeconds),
      velocity: Math.round(clamp(note.amplitude, 0.02, 1) * 127)
    }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, width, height, safeRadius);
  else ctx.rect(x, y, width, height);
}

function drawPianoRoll(result) {
  if (!result) return;
  const notes = result.notes;
  const viewportWidth = Math.max(280, Math.floor(pianoViewport.clientWidth || 640));
  const width = getTimelineWidth(result.duration, viewportWidth, pianoZoom);
  let minPitch = 127;
  let maxPitch = 0;
  for (const note of notes) {
    minPitch = Math.min(minPitch, note.pitch);
    maxPitch = Math.max(maxPitch, note.pitch);
  }

  let low = notes.length ? Math.max(0, minPitch - 2) : 48;
  let high = notes.length ? Math.min(127, maxPitch + 2) : 71;
  if (high - low + 1 < 12) {
    low = Math.max(0, low - Math.ceil((12 - (high - low + 1)) / 2));
    high = Math.min(127, low + 11);
    low = Math.max(0, high - 11);
  }

  const span = high - low + 1;
  const rowHeight = Math.max(8, Math.min(17, 540 / span));
  const left = 66;
  const right = 20;
  const top = 48;
  const bottom = 28;
  const height = Math.ceil(top + span * rowHeight + bottom);
  const duration = Math.max(1, result.duration);
  const plotWidth = Math.max(1, width - left - right);
  const pixelsPerSecond = plotWidth / duration;
  const ratio = getCanvasPixelRatio(width, height, window.devicePixelRatio || 1);

  pianoStage.style.width = width + "px";
  pianoStage.style.height = height + "px";
  for (const target of [canvas, playheadCanvas]) {
    target.width = Math.round(width * ratio);
    target.height = Math.round(height * ratio);
    target.style.width = width + "px";
    target.style.height = height + "px";
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f8f9fc";
  ctx.fillRect(0, 0, width, height);

  const beatSeconds = 60 / result.bpm * (4 / result.denominator);
  const barSeconds = beatSeconds * result.numerator;
  const barWidth = barSeconds * pixelsPerSecond;
  const barCount = Math.ceil(duration / barSeconds);

  for (let bar = 0; bar < barCount; bar++) {
    const x = left + bar * barWidth;
    const nextX = Math.min(left + plotWidth, x + barWidth);
    if (bar % 2 === 1) {
      ctx.fillStyle = "rgba(104, 121, 190, .035)";
      ctx.fillRect(x, top, Math.max(0, nextX - x), height - top - bottom);
    }
  }

  ctx.fillStyle = "#f1f3f8";
  ctx.fillRect(0, 0, width, top);
  ctx.fillStyle = "#252a35";
  ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("KEY", left / 2, top / 2);
  ctx.fillStyle = "#747d91";
  ctx.textAlign = "left";
  ctx.fillText("MEASURES", left + 8, 12);

  const labelEvery = Math.max(1, Math.ceil(64 / Math.max(1, barWidth)));
  for (let bar = 0; bar <= barCount; bar++) {
    const x = left + bar * barWidth;
    if (x > left + plotWidth + 1) break;
    ctx.strokeStyle = "rgba(76, 91, 132, .22)";
    ctx.lineWidth = bar === 0 ? 1.4 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 18);
    ctx.lineTo(x, height - bottom);
    ctx.stroke();
    if (bar < barCount && bar % labelEvery === 0 && barWidth >= 18) {
      ctx.fillStyle = "#66718a";
      ctx.font = "600 9px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(String(bar + 1).padStart(2, "0"), x + 7, 31);
      if (barWidth > 94) {
        ctx.fillStyle = "#a0a6b3";
        ctx.font = "9px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillText(formatTime(bar * barSeconds), x + 7, 41);
      }
    }
  }

  // Restore pitch separators after measure shading is painted.
  for (let pitch = low; pitch <= high; pitch++) {
    const y = top + (high - pitch + 1) * rowHeight;
    ctx.strokeStyle = pitch % 12 === 0 ? "#d3d9e7" : "#e9ecf2";
    ctx.lineWidth = pitch % 12 === 0 ? 1 : 0.65;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();
  }

  const beatCount = Math.ceil(duration / beatSeconds);
  for (let beat = 0; beat <= beatCount; beat++) {
    const x = left + beat * beatSeconds * pixelsPerSecond;
    if (x > left + plotWidth) break;
    const isBar = beat % result.numerator === 0;
    ctx.strokeStyle = isBar ? "rgba(76, 91, 132, .24)" : "rgba(76, 91, 132, .105)";
    ctx.lineWidth = isBar ? 1.15 : 0.7;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, height - bottom);
    ctx.stroke();
    if (beat < beatCount && barWidth > 36) {
      const halfX = x + beatSeconds * pixelsPerSecond / 2;
      ctx.strokeStyle = "rgba(76, 91, 132, .055)";
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(halfX, top);
      ctx.lineTo(halfX, height - bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  const blackPitchClasses = new Set([1, 3, 6, 8, 10]);
  for (let pitch = low; pitch <= high; pitch++) {
    const y = top + (high - pitch) * rowHeight;
    const blackKey = blackPitchClasses.has(pitch % 12);
    ctx.fillStyle = blackKey ? "#f1f3f8" : "#ffffff";
    ctx.fillRect(left, y, plotWidth, rowHeight);
    ctx.strokeStyle = pitch % 12 === 0 ? "#d3d9e7" : "#e9ecf2";
    ctx.lineWidth = pitch % 12 === 0 ? 1 : 0.65;
    ctx.beginPath();
    ctx.moveTo(left, y + rowHeight);
    ctx.lineTo(width - right, y + rowHeight);
    ctx.stroke();

    if (blackKey) {
      ctx.fillStyle = "#272b35";
      drawRoundedRect(ctx, 3, y + 1, left * 0.67, Math.max(3, rowHeight - 2), 3);
      ctx.fill();
    } else {
      ctx.fillStyle = "#fff";
      ctx.fillRect(3, y + 1, left - 7, Math.max(2, rowHeight - 2));
      ctx.strokeStyle = "#d9dde6";
      ctx.strokeRect(3, y + 1, left - 7, Math.max(2, rowHeight - 2));
    }

    if (pitch % 12 === 0) {
      ctx.fillStyle = "#4a5262";
      ctx.font = "600 9px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(midiNoteName(pitch), left * 0.34, y + rowHeight / 2);
    }
  }

  // Repaint measure shading and beat lines above the key-row backgrounds.
  for (let bar = 0; bar < barCount; bar++) {
    const x = left + bar * barWidth;
    if (bar % 2 === 1) {
      ctx.fillStyle = "rgba(104, 121, 190, .035)";
      ctx.fillRect(x, top, Math.max(0, Math.min(left + plotWidth, x + barWidth) - x), height - top - bottom);
    }
  }
  for (let beat = 0; beat <= beatCount; beat++) {
    const x = left + beat * beatSeconds * pixelsPerSecond;
    if (x > left + plotWidth) break;
    const isBar = beat % result.numerator === 0;
    ctx.strokeStyle = isBar ? "rgba(76, 91, 132, .24)" : "rgba(76, 91, 132, .105)";
    ctx.lineWidth = isBar ? 1.15 : 0.7;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, height - bottom);
    ctx.stroke();
    if (beat < beatCount && barWidth > 36) {
      const halfX = x + beatSeconds * pixelsPerSecond / 2;
      ctx.strokeStyle = "rgba(76, 91, 132, .055)";
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(halfX, top);
      ctx.lineTo(halfX, height - bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  for (const note of notes) {
    if (!Number.isFinite(note.start) || !Number.isFinite(note.end) ||
        !Number.isFinite(note.pitch) || note.pitch < low || note.pitch > high) continue;
    const start = Math.max(0, note.start);
    const end = Math.min(duration, note.end);
    if (end <= start) continue;
    const x = left + start * pixelsPerSecond;
    const y = top + (high - note.pitch) * rowHeight + 1;
    const noteWidth = Math.max(3, (end - start) * pixelsPerSecond);
    const noteHeight = Math.max(3, rowHeight - 2);
    const strength = Math.max(.45, Math.min(1, (note.velocity || 80) / 127));
    const gradient = ctx.createLinearGradient(x, y, x, y + noteHeight);
    gradient.addColorStop(0, strength > .8 ? "#91a5ff" : "#a5b4f6");
    gradient.addColorStop(1, "#627be0");
    ctx.fillStyle = gradient;
    ctx.shadowColor = "rgba(72, 92, 176, .16)";
    ctx.shadowBlur = 3;
    drawRoundedRect(ctx, x + .6, y, noteWidth, noteHeight, Math.min(4, noteHeight / 2));
    ctx.fill();
    ctx.shadowBlur = 0;

    if (noteWidth >= 48 && rowHeight >= 12) {
      ctx.fillStyle = "rgba(255,255,255,.95)";
      ctx.font = "600 9px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(midiNoteName(note.pitch), x + 6, y + noteHeight / 2, noteWidth - 10);
    }
  }

  pianoLayout = { left, plotWidth, duration, width, height, ratio };
  $("pitchRange").textContent = notes.length
    ? notes.length.toLocaleString("ja-JP") + " notes · " + midiNoteName(low) + " – " + midiNoteName(high)
    : "ノートが検出されませんでした。";
  $("zoomLabel").textContent = Math.round(pianoZoom * 100) + "%";
  clearPlayhead();
}

function drawPlayhead(seconds) {
  if (!pianoLayout) return;
  const ctx = playheadCanvas.getContext("2d");
  const { left, plotWidth, duration, width, height, ratio } = pianoLayout;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const x = left + Math.max(0, Math.min(duration, seconds)) / duration * plotWidth;
  ctx.save();
  ctx.strokeStyle = "#566fe0";
  ctx.lineWidth = 1.8;
  ctx.shadowColor = "rgba(86, 111, 224, .45)";
  ctx.shadowBlur = 7;
  ctx.beginPath();
  ctx.moveTo(x, 17);
  ctx.lineTo(x, height - 17);
  ctx.stroke();
  ctx.fillStyle = "#566fe0";
  ctx.beginPath();
  ctx.arc(x, 17, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function clearPlayhead() {
  const ctx = playheadCanvas.getContext("2d");
  if (!ctx) return;
  const width = pianoLayout?.width || 1;
  const height = pianoLayout?.height || 1;
  const ratio = pianoLayout?.ratio || Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
}

function changePianoZoom(nextZoom, fitToWidth = false) {
  if (!latestResult) return;
  const previousWidth = pianoLayout?.width || pianoViewport.scrollWidth;
  const center = pianoViewport.scrollLeft + pianoViewport.clientWidth / 2;
  if (fitToWidth) {
    const fit = (pianoViewport.clientWidth - 84) / Math.max(1, latestResult.duration * 72);
    pianoZoom = clamp(fit, 0.06, 5);
  } else {
    pianoZoom = clamp(nextZoom, 0.06, 5);
  }
  drawPianoRoll(latestResult);
  const scale = pianoLayout.width / Math.max(1, previousWidth);
  pianoViewport.scrollLeft = fitToWidth ? 0 : Math.max(0, center * scale - pianoViewport.clientWidth / 2);
}

function showResult(result) {
  $("noteCount").textContent = result.notes.length.toLocaleString("ja-JP");
  $("resultBpm").textContent = Number(result.bpm).toFixed(1).replace(/\.0$/, "");
  $("resultMeter").textContent = result.numerator + "/" + result.denominator;
  $("resultDuration").textContent = formatTime(result.duration);
  $("downloadFilename").textContent = result.filename;
  $("playButton").disabled = result.notes.length === 0;
  $("stopButton").disabled = true;
  resultSection.classList.remove("hidden");
  drawPianoRoll(result);
  resultSection.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start"
  });
}

async function convert() {
  if (!selectedFile || isConverting) return;
  const fileToConvert = selectedFile;
  clearError();
  stopPlayback();
  latestResult = null;
  resultSection.classList.add("hidden");
  setBusy(true);

  try {
    setProgress(3, "音声ファイルを読み込んでいます", "ブラウザ内で音声を展開しています。");
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const { samples: rawSamples, duration } = await decodeAndResample(fileToConvert);
    const samples = applyNoiseGate(rawSamples, Number($("noiseReduction").value));
    const sensitivity = Number($("sensitivity").value);

    setProgress(7, "AIモデルを準備しています", "Basic Pitchモデルを読み込んでいます。");
    const detectedNotes = await transcribe(samples, sensitivity);
    if (!detectedNotes.length) {
      throw new Error("ノートを検出できませんでした。感度を上げるか、より音が明瞭な音源をお試しください。");
    }

    const tempoMode = $("tempoMode").value;
    const bpm = tempoMode === "manual"
      ? clamp(Number($("bpmInput").value) || 120, 40, 240)
      : detectTempo(samples);
    const numerator = Number($("timeSigNum").value);
    const denominator = Number($("timeSigDen").value);
    const filename = safeStem(fileToConvert.name) + ".mid";
    const midiBlob = buildMidi(detectedNotes, bpm, numerator, denominator);

    latestResult = {
      notes: detectedNotes,
      duration,
      bpm,
      numerator,
      denominator,
      filename,
      midiBlob
    };
    setProgress(100, "変換が完了しました", detectedNotes.length + " 個のノートを検出しました。");
    showResult(latestResult);
  } catch (error) {
    console.error(error);
    setError(error?.message || "変換に失敗しました。別の音源で再度お試しください。");
  } finally {
    setBusy(false);
  }
}

convertButton.addEventListener("click", convert);

async function getPlaybackContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("音声プレビューに対応していません。");
  if (!audioContext || audioContext.state === "closed") audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

function stopPlayback() {
  if (playbackFrame) window.cancelAnimationFrame(playbackFrame);
  playbackFrame = 0;
  playbackStartAt = 0;
  for (const voice of activeVoices) {
    try { voice.oscillator.stop(); } catch {}
    try { voice.oscillator.disconnect(); } catch {}
    try { voice.filter.disconnect(); } catch {}
    try { voice.gain.disconnect(); } catch {}
  }
  activeVoices = [];
  for (const node of playbackBus) {
    try { node.disconnect(); } catch {}
  }
  playbackBus = [];
  clearPlayhead();
  $("playButton").disabled = !(latestResult?.notes?.length);
  $("stopButton").disabled = true;
}

function updatePlaybackCursor() {
  if (!audioContext || !playbackStartAt || !latestResult) return;
  const elapsed = audioContext.currentTime - playbackStartAt;
  if (elapsed >= latestResult.duration + 0.12) {
    stopPlayback();
    return;
  }
  drawPlayhead(elapsed);
  playbackFrame = window.requestAnimationFrame(updatePlaybackCursor);
}

async function playPreview() {
  if (!latestResult?.notes?.length) return;
  stopPlayback();
  try {
    const context = await getPlaybackContext();
    const master = context.createGain();
    const compressor = context.createDynamicsCompressor();
    const volume = Number($("previewVolume").value) / 100;
    master.gain.value = 0.78 * clamp(volume, 0, 1);
    compressor.threshold.value = -20;
    compressor.knee.value = 18;
    compressor.ratio.value = 5.5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;
    master.connect(compressor);
    compressor.connect(context.destination);
    playbackBus = [master, compressor];

    const partials = PREVIEW_TONES[$("previewTone").value] || PREVIEW_TONES.piano;
    const real = new Float32Array(partials.length + 1);
    const imaginary = new Float32Array(partials.length + 1);
    partials.forEach((amplitude, index) => { real[index + 1] = amplitude; });
    const pianoWave = context.createPeriodicWave(real, imaginary);
    const startAt = context.currentTime + 0.1;

    for (const note of latestResult.notes.slice(0, 5000)) {
      const noteStart = Math.max(0, note.start);
      const noteEnd = Math.max(noteStart + 0.035, note.end);
      const start = startAt + noteStart;
      const end = startAt + noteEnd;
      const frequency = midiToFrequency(note.pitchFloat ?? note.pitch);
      const peak = Math.max(0.0005, velocityGain(clamp(note.velocity ?? 84, 0, 127)));
      const attackEnd = start + Math.min(0.012, (end - start) * 0.24);
      const decayEnd = Math.min(end - 0.015, start + 0.28);
      const releaseStart = Math.max(attackEnd, decayEnd, end - 0.055);
      const sustain = Math.max(0.0005, peak * 0.38);

      const oscillator = context.createOscillator();
      oscillator.setPeriodicWave(pianoWave);
      oscillator.frequency.setValueAtTime(frequency, start);

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(Math.min(11000, 2300 + frequency * 6), start);
      filter.Q.setValueAtTime(0.65, start);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, attackEnd);
      if (decayEnd > attackEnd) gain.gain.exponentialRampToValueAtTime(sustain, decayEnd);
      gain.gain.setValueAtTime(sustain, releaseStart);
      gain.gain.exponentialRampToValueAtTime(0.0001, end + 0.085);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      oscillator.start(start);
      oscillator.stop(end + 0.09);
      oscillator.onended = () => {
        try { oscillator.disconnect(); } catch {}
        try { filter.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
      };
      activeVoices.push({ oscillator, filter, gain });
    }

    pianoViewport.scrollLeft = 0;
    $("playButton").disabled = true;
    $("stopButton").disabled = false;
    playbackStartAt = startAt;
    drawPlayhead(0);
    playbackFrame = window.requestAnimationFrame(updatePlaybackCursor);
  } catch (error) {
    stopPlayback();
    setError(error?.message || "プレビューを再生できませんでした。");
  }
}

$("playButton").addEventListener("click", playPreview);
$("stopButton").addEventListener("click", stopPlayback);
$("zoomIn").addEventListener("click", () => changePianoZoom(pianoZoom * 1.35));
$("zoomOut").addEventListener("click", () => changePianoZoom(pianoZoom / 1.35));
$("zoomFit").addEventListener("click", () => changePianoZoom(pianoZoom, true));
$("previewVolume").addEventListener("input", () => {
  $("previewVolumeValue").textContent = $("previewVolume").value + "%";
});

$("downloadButton").addEventListener("click", () => {
  if (!latestResult?.midiBlob) return;
  const url = URL.createObjectURL(latestResult.midiBlob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = latestResult.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
});

window.addEventListener("resize", () => {
  if (latestResult) drawPianoRoll(latestResult);
});

window.addEventListener("beforeunload", () => {
  stopPlayback();
  if (selectedObjectUrl) URL.revokeObjectURL(selectedObjectUrl);
  if (audioContext && audioContext.state !== "closed") audioContext.close();
});
