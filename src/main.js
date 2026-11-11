import * as tf from "@tensorflow/tfjs";
import { buildMidi, clamp, midiNoteName } from "./midi.js";
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
let activeOscillators = [];
let playbackTimer = null;
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
  bar.style.width = Math.max(2, Math.min(100, percent)) + "%";
  bar.style.animation = "none";
}

function setBusy(busy) {
  isConverting = busy;
  convertButton.disabled = busy || !selectedFile;
  $("heroSelectButton").disabled = busy;
  $("chooseFile").disabled = busy;
  $("removeFile").disabled = busy;
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
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 70) || "transcription";
}

function setFile(file) {
  if (!file || isConverting) return;
  clearError();
  stopPlayback();

  if (file.size > MAX_FILE_BYTES) {
    setError("ファイルは30 MB以内にしてください。");
    return;
  }
  if (file.size === 0) {
    setError("空のファイルは選択できません。");
    return;
  }

  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  const allowed = [".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aiff", ".aif"];
  if (!allowed.includes(ext)) {
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
$("heroSelectButton").addEventListener("click", () => fileInput.click());
dropzone.addEventListener("click", (event) => {
  if (!event.target.closest("button")) fileInput.click();
});
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => setFile(fileInput.files[0]));
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
  for (let i = 0; i < onset.length; i++) onset[i] = Math.max(0, onset[i] - mean);

  let bestBpm = 120;
  let bestScore = -Infinity;
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

    const model = new BasicPitch(MODEL_URL);
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
      name: midiNoteName(Math.round(note.pitchMidi)),
      start: Math.max(0, note.startTimeSeconds),
      end: Math.max(note.startTimeSeconds + 0.025, note.startTimeSeconds + note.durationSeconds),
      velocity: Math.round(clamp(note.amplitude, 0.02, 1) * 127)
    }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

function drawPianoRoll(result) {
  const notes = result.notes;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(640, Math.floor(rect.width));
  const height = 300;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const left = 48;
  const right = 16;
  const top = 14;
  const bottom = 24;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const duration = Math.max(1, result.duration);
  let minPitch = 127;
  let maxPitch = 0;
  for (const note of notes) {
    minPitch = Math.min(minPitch, note.pitch);
    maxPitch = Math.max(maxPitch, note.pitch);
  }
  const low = notes.length ? Math.max(0, minPitch - 2) : 48;
  const high = notes.length ? Math.min(127, maxPitch + 2) : 72;
  const span = Math.max(12, high - low + 1);
  const rowHeight = plotHeight / span;

  ctx.fillStyle = "#fbfbfc";
  ctx.fillRect(0, 0, width, height);
  ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let pitch = low; pitch <= high; pitch++) {
    const y = top + (high - pitch) * rowHeight;
    ctx.fillStyle = pitch % 12 === 0 ? "#e8e9ec" : "#f0f1f3";
    ctx.fillRect(left, y + rowHeight - 1, plotWidth, 1);
    if (pitch % 12 === 0 || pitch === low || pitch === high) {
      ctx.fillStyle = "#737780";
      ctx.fillText(midiNoteName(pitch), left - 8, y + rowHeight / 2);
    }
  }

  const measureSeconds = 60 / result.bpm * result.numerator;
  for (let second = 0; second <= duration; second += measureSeconds) {
    const x = left + (second / duration) * plotWidth;
    ctx.strokeStyle = "#e6e7ea";
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + plotHeight);
    ctx.stroke();
    ctx.fillStyle = "#858992";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(formatTime(second), x, top + plotHeight + 7);
  }

  for (const note of notes) {
    const x = left + (note.start / duration) * plotWidth;
    const w = Math.max(2, ((note.end - note.start) / duration) * plotWidth);
    const y = top + (high - note.pitch) * rowHeight + 1;
    const alpha = 0.45 + note.velocity / 127 * 0.5;
    ctx.fillStyle = "rgba(36, 39, 45, " + alpha.toFixed(2) + ")";
    ctx.beginPath();
    ctx.roundRect(x, y, w, Math.max(3, rowHeight - 2), Math.min(4, rowHeight / 3));
    ctx.fill();
  }

  $("pitchRange").textContent = notes.length
    ? notes.length.toLocaleString("ja-JP") + " notes · " + low + "–" + high + " MIDI"
    : "ノートが検出されませんでした。感度を調整して再変換してください。";
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
  clearError();
  stopPlayback();
  setBusy(true);

  try {
    setProgress(3, "音声ファイルを読み込んでいます", "ブラウザ内で音声を展開しています。");
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const { samples: rawSamples, duration } = await decodeAndResample(selectedFile);
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
    const filename = safeStem(selectedFile.name) + ".mid";
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
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContextClass();
  }
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

async function playPreview() {
  if (!latestResult?.notes?.length) return;
  stopPlayback();
  try {
    const context = await getPlaybackContext();
    const startAt = context.currentTime + 0.1;
    const master = context.createGain();
    master.gain.value = 0.72;
    master.connect(context.destination);

    for (const note of latestResult.notes.slice(0, 5000)) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = startAt + note.start;
      const end = startAt + note.end;
      const frequency = 440 * Math.pow(2, (note.pitch - 69) / 12);
      const amplitude = Math.max(0.008, note.velocity / 127 * 0.1);
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(amplitude, start + 0.012);
      gain.gain.setValueAtTime(amplitude, Math.max(start + 0.014, end - 0.035));
      gain.gain.exponentialRampToValueAtTime(0.0001, Math.max(start + 0.02, end));
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(start);
      oscillator.stop(end + 0.025);
      activeOscillators.push(oscillator);
    }

    $("playButton").disabled = true;
    $("stopButton").disabled = false;
    playbackTimer = window.setTimeout(stopPlayback, (latestResult.duration + 0.5) * 1000);
  } catch (error) {
    setError(error?.message || "プレビューを再生できませんでした。");
  }
}

function stopPlayback() {
  for (const oscillator of activeOscillators) {
    try { oscillator.stop(); } catch {}
    try { oscillator.disconnect(); } catch {}
  }
  activeOscillators = [];
  if (playbackTimer) window.clearTimeout(playbackTimer);
  playbackTimer = null;
  $("playButton").disabled = !(latestResult?.notes?.length);
  $("stopButton").disabled = true;
}

$("playButton").addEventListener("click", playPreview);
$("stopButton").addEventListener("click", stopPlayback);

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

function setupScrollReveal() {
  const elements = Array.from(document.querySelectorAll("[data-reveal]"));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!("IntersectionObserver" in window) || reducedMotion) {
    elements.forEach((element) => element.classList.add("is-visible"));
    return;
  }

  document.documentElement.classList.add("motion-ready");
  const observer = new IntersectionObserver((entries, instance) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        instance.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.14,
    rootMargin: "0px 0px -42px 0px"
  });

  elements.forEach((element, index) => {
    element.style.setProperty("--reveal-delay", Math.min(index % 3, 2) * 85 + "ms");
    observer.observe(element);
  });
}

setupScrollReveal();

fetch(MODEL_URL, { method: "HEAD" })
  .then((response) => {
    if (!response.ok) throw new Error("model is missing");
    document.body.classList.add("app-ready");
  })
  .catch(() => {
    setError("AIモデルを読み込めません。GitHub Pagesの公開設定か、モデルファイルの配置を確認してください。");
  });
