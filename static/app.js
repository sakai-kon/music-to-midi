(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const fileInput = byId("fileInput");
  const dropzone = byId("dropzone");
  const chooseFile = byId("chooseFile");
  const convertButton = byId("convertButton");
  const convertButtonText = byId("convertButtonText");
  const progressPanel = byId("progressPanel");
  const errorMessage = byId("errorMessage");
  const resultSection = byId("resultSection");
  const sensitivity = byId("sensitivity");
  const noiseReduction = byId("noiseReduction");
  const tempoMode = byId("tempoMode");
  const bpmInput = byId("bpmInput");
  const audioPreview = byId("audioPreview");
  const canvas = byId("pianoRoll");

  let selectedFile = null;
  let audioObjectUrl = null;
  let latestResult = null;
  let audioContext = null;
  let activeOscillators = [];
  let playheadFrame = null;
  let playbackStartedAt = 0;

  const maxBytes = 50 * 1024 * 1024;
  const maxDurationSeconds = 6 * 60;
  const acceptedExtensions = [".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aiff", ".aif"];

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(seconds || 0));
    return Math.floor(safe / 60) + ":" + String(safe % 60).padStart(2, "0");
  }

  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.remove("hidden");
  }

  function clearError() {
    errorMessage.textContent = "";
    errorMessage.classList.add("hidden");
  }

  function setBusy(busy) {
    convertButton.disabled = busy || !selectedFile;
    chooseFile.disabled = busy;
    byId("removeFile").disabled = busy;
    convertButtonText.textContent = busy ? "解析しています..." : "MIDIに変換";
    progressPanel.classList.toggle("hidden", !busy);
    if (busy) {
      byId("progressTitle").textContent = "音源を解析しています";
      byId("progressPercent").textContent = "PROCESSING";
      byId("progressMessage").textContent = "ノート、オンセット、音価を推定しています。音源の長さによって時間がかかります。";
    }
  }

  function setFile(file) {
    clearError();
    if (!file) return;
    const lowerName = file.name.toLowerCase();
    if (!acceptedExtensions.some((extension) => lowerName.endsWith(extension))) {
      showError("対応形式は MP3 / WAV / FLAC / M4A / OGG / AIFF です。");
      return;
    }
    if (file.size > maxBytes) {
      showError("ファイルは50 MB以内にしてください。");
      return;
    }
    if (file.size === 0) {
      showError("空のファイルは選択できません。");
      return;
    }
    selectedFile = file;
    byId("fileName").textContent = file.name;
    byId("fileSize").textContent = formatBytes(file.size);
    byId("fileInfo").classList.remove("hidden");
    dropzone.classList.add("compact");
    convertButton.disabled = false;
    resultSection.classList.add("hidden");
    latestResult = null;

    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = URL.createObjectURL(file);
    audioPreview.src = audioObjectUrl;
    byId("audioPreviewWrap").classList.remove("hidden");
  }

  function clearFile() {
    selectedFile = null;
    fileInput.value = "";
    byId("fileInfo").classList.add("hidden");
    byId("audioPreviewWrap").classList.add("hidden");
    dropzone.classList.remove("compact");
    convertButton.disabled = true;
    audioPreview.pause();
    audioPreview.removeAttribute("src");
    audioPreview.load();
    if (audioObjectUrl) {
      URL.revokeObjectURL(audioObjectUrl);
      audioObjectUrl = null;
    }
    clearError();
  }

  chooseFile.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    fileInput.click();
  });
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => setFile(fileInput.files[0]));
  byId("removeFile").addEventListener("click", clearFile);

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
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) setFile(file);
  });

  sensitivity.addEventListener("input", () => {
    byId("sensitivityValue").value = sensitivity.value;
    byId("sensitivityValue").textContent = sensitivity.value;
  });
  noiseReduction.addEventListener("input", () => {
    byId("noiseValue").value = noiseReduction.value + "%";
    byId("noiseValue").textContent = noiseReduction.value + "%";
  });
  tempoMode.addEventListener("change", () => {
    bpmInput.disabled = tempoMode.value !== "manual";
  });

  async function convert() {
    if (!selectedFile) return;
    clearError();
    stopPreview();
    setBusy(true);

    const form = new FormData();
    form.append("file", selectedFile);
    form.append("sensitivity", sensitivity.value);
    form.append("noise_reduction", noiseReduction.value);
    form.append("tempo_mode", tempoMode.value);
    form.append("bpm", bpmInput.value || "120");
    form.append("time_signature_numerator", byId("timeSigNum").value);
    form.append("time_signature_denominator", byId("timeSigDen").value);

    try {
      const response = await fetch("/api/convert", {
        method: "POST",
        body: form
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.detail || "変換に失敗しました。設定やファイル形式を確認してください。");
      }
      latestResult = payload;
      showResult(payload);
    } catch (error) {
      showError(error && error.message ? error.message : "通信エラーが発生しました。");
    } finally {
      setBusy(false);
    }
  }

  convertButton.addEventListener("click", convert);

  function showResult(result) {
    byId("noteCount").textContent = Number(result.note_count || 0).toLocaleString("ja-JP");
    byId("resultBpm").textContent = Number(result.bpm || 120).toFixed(1).replace(/\\.0$/, "");
    byId("resultMeter").textContent = result.time_signature || "4/4";
    byId("resultDuration").textContent = formatTime(result.duration);
    byId("downloadFilename").textContent = result.filename || "transcription.mid";
    byId("playButton").disabled = !result.notes || result.notes.length === 0;
    byId("stopButton").disabled = true;
    resultSection.classList.remove("hidden");
    drawPianoRoll(result);
    resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function drawPianoRoll(result) {
    const notes = Array.isArray(result.notes) ? result.notes : [];
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(640, Math.floor(rect.width));
    const height = 300;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const left = 48;
    const right = 16;
    const top = 14;
    const bottom = 24;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const duration = Math.max(1, Number(result.duration) || 1);
    const pitchValues = notes.map((note) => Number(note.pitch));
    const low = pitchValues.length ? Math.max(0, Math.min.apply(null, pitchValues) - 2) : 48;
    const high = pitchValues.length ? Math.min(127, Math.max.apply(null, pitchValues) + 2) : 72;
    const pitchSpan = Math.max(12, high - low + 1);
    const rowHeight = plotHeight / pitchSpan;

    ctx.fillStyle = "#fbfbfc";
    ctx.fillRect(0, 0, width, height);
    ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let pitch = low; pitch <= high; pitch += 1) {
      const y = top + (high - pitch) * rowHeight;
      const pitchClass = pitch % 12;
      const isC = pitchClass === 0;
      ctx.fillStyle = isC ? "#e8e9ec" : "#f0f1f3";
      ctx.fillRect(left, y + rowHeight - 1, plotWidth, 1);
      if (isC || pitch === high || pitch === low) {
        ctx.fillStyle = "#737780";
        ctx.fillText((pitch % 12 === 0 ? "C" : "") + Math.floor(pitch / 12 - 1), left - 8, y + rowHeight / 2);
      }
    }

    const barSeconds = Math.max(1, Number(result.bpm) > 0 ? (60 / Number(result.bpm)) * 4 : 2);
    for (let second = 0; second <= duration; second += barSeconds) {
      const x = left + (second / duration) * plotWidth;
      ctx.strokeStyle = "#e6e7ea";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotHeight);
      ctx.stroke();
      ctx.fillStyle = "#858992";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(formatTime(second), x, top + plotHeight + 7);
    }

    notes.forEach((note) => {
      const pitch = Number(note.pitch);
      const start = Math.max(0, Number(note.start));
      const end = Math.max(start + 0.025, Number(note.end));
      const x = left + (start / duration) * plotWidth;
      const noteWidth = Math.max(2, ((end - start) / duration) * plotWidth);
      const y = top + (high - pitch) * rowHeight + 1;
      const alpha = 0.45 + Math.max(0, Math.min(1, Number(note.velocity) / 127)) * 0.5;
      ctx.fillStyle = "rgba(36, 39, 45, " + alpha.toFixed(2) + ")";
      ctx.beginPath();
      const radius = Math.min(4, Math.max(1, rowHeight / 3));
      ctx.roundRect(x, y, noteWidth, Math.max(3, rowHeight - 2), radius);
      ctx.fill();
    });

    byId("pitchRange").textContent = notes.length
      ? notes.length.toLocaleString("ja-JP") + " notes · " + low + "–" + high + " MIDI"
      : "ノートが検出されませんでした。感度を上げて再変換してください。";
  }

  async function getAudioContext() {
    if (!audioContext) {
      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextConstructor) throw new Error("このブラウザは音声プレビューに対応していません。");
      audioContext = new AudioContextConstructor();
    }
    if (audioContext.state === "suspended") await audioContext.resume();
    return audioContext;
  }

  async function playPreview() {
    if (!latestResult || !latestResult.notes || latestResult.notes.length === 0) return;
    stopPreview();
    try {
      const context = await getAudioContext();
      const startAt = context.currentTime + 0.12;
      playbackStartedAt = startAt;
      const master = context.createGain();
      master.gain.value = 0.72;
      master.connect(context.destination);
      const notes = latestResult.notes.slice(0, 6000);

      notes.forEach((note) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const velocity = Math.max(1, Math.min(127, Number(note.velocity) || 80)) / 127;
        const start = startAt + Math.max(0, Number(note.start) || 0);
        const end = startAt + Math.max(Number(note.end), Number(note.start) + 0.04);
        const frequency = 440 * Math.pow(2, (Number(note.pitch) - 69) / 12);
        oscillator.type = "triangle";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(Math.max(0.008, velocity * 0.10), start + 0.012);
        gain.gain.setValueAtTime(Math.max(0.008, velocity * 0.10), Math.max(start + 0.013, end - 0.035));
        gain.gain.exponentialRampToValueAtTime(0.0001, Math.max(start + 0.02, end));
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(start);
        oscillator.stop(end + 0.02);
        activeOscillators.push(oscillator);
      });

      byId("playButton").disabled = true;
      byId("stopButton").disabled = false;
      const totalMs = Math.max(0, (Number(latestResult.duration) + 0.3) * 1000);
      window.setTimeout(() => {
        if (activeOscillators.length) stopPreview();
      }, totalMs);
    } catch (error) {
      showError(error.message || "プレビューを再生できませんでした。");
    }
  }

  function stopPreview() {
    activeOscillators.forEach((oscillator) => {
      try { oscillator.stop(); } catch (_) { /* already stopped */ }
      try { oscillator.disconnect(); } catch (_) { /* already disconnected */ }
    });
    activeOscillators = [];
    if (playheadFrame) cancelAnimationFrame(playheadFrame);
    playheadFrame = null;
    byId("playButton").disabled = !(latestResult && latestResult.notes && latestResult.notes.length);
    byId("stopButton").disabled = true;
  }

  byId("playButton").addEventListener("click", playPreview);
  byId("stopButton").addEventListener("click", stopPreview);

  byId("downloadButton").addEventListener("click", () => {
    if (!latestResult || !latestResult.midi_base64) return;
    const binary = atob(latestResult.midi_base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const blob = new Blob([bytes], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = latestResult.filename || "transcription.mid";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  window.addEventListener("resize", () => {
    if (latestResult) drawPianoRoll(latestResult);
  });

  fetch("/api/health")
    .then((response) => {
      if (!response.ok) throw new Error("not ready");
      return response.json();
    })
    .then(() => document.body.classList.add("app-ready"))
    .catch(() => showError("APIに接続できません。READMEの手順でサーバーを起動してください。"));

  // Keep a reference to the duration cap in the client for clearer UX.
  void maxDurationSeconds;
})();
