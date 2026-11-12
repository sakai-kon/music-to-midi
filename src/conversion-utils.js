const BPM_MIN = 40;
const BPM_MAX = 240;
const ALLOWED_DENOMINATORS = new Set([1, 2, 4, 8, 16]);

export function validateConversionSettings(settings) {
  if (!settings || typeof settings !== "object") {
    throw new TypeError("変換設定を読み取れませんでした。");
  }

  const tempoMode = settings.tempoMode;
  if (tempoMode !== "auto" && tempoMode !== "manual") {
    throw new RangeError("テンポ設定を選び直してください。");
  }

  const bpm = Number(settings.bpm);
  if (tempoMode === "manual" && (!Number.isFinite(bpm) || bpm < BPM_MIN || bpm > BPM_MAX)) {
    throw new RangeError("手動テンポは40〜240 BPMの範囲で指定してください。");
  }

  const numerator = Number(settings.numerator);
  const denominator = Number(settings.denominator);
  const sensitivity = Number(settings.sensitivity);
  const noiseReduction = Number(settings.noiseReduction);

  if (!Number.isInteger(numerator) || numerator < 2 || numerator > 12) {
    throw new RangeError("拍子の分子は2〜12から選択してください。");
  }
  if (!Number.isInteger(denominator) || !ALLOWED_DENOMINATORS.has(denominator)) {
    throw new RangeError("拍子の分母を選び直してください。");
  }
  if (!Number.isFinite(sensitivity) || sensitivity < 0 || sensitivity > 100) {
    throw new RangeError("検出感度は0〜100の範囲で指定してください。");
  }
  if (!Number.isFinite(noiseReduction) || noiseReduction < 0 || noiseReduction > 100) {
    throw new RangeError("ノイズ低減は0〜100の範囲で指定してください。");
  }

  return Object.freeze({
    tempoMode,
    bpm: tempoMode === "manual" ? bpm : null,
    numerator,
    denominator,
    sensitivity,
    noiseReduction
  });
}

export function clipNotesToDuration(notes, duration) {
  const limit = Number(duration);
  if (!Array.isArray(notes)) throw new TypeError("ノート一覧が不正です。");
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError("音源の長さが不正です。");
  }

  const clipped = [];
  for (const note of notes) {
    if (!note || typeof note !== "object") continue;
    const start = Number(note.start);
    const end = Number(note.end);
    const pitch = Number(note.pitch);
    if (!Number.isFinite(start) || !Number.isFinite(end) ||
        !Number.isInteger(pitch) || pitch < 0 || pitch > 127) continue;

    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(limit, end);
    if (safeStart >= limit || safeEnd <= safeStart) continue;
    clipped.push({ ...note, start: safeStart, end: safeEnd });
  }
  return clipped;
}
