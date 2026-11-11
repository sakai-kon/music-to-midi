from __future__ import annotations

import base64
import logging
import math
import re
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

import imageio_ffmpeg
import librosa
import numpy as np
import pretty_midi
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
SAMPLE_RATE = 22_050
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_AUDIO_SECONDS = 6 * 60
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aiff", ".aif"}
TIME_SIGNATURE_DENOMINATORS = {1, 2, 4, 8, 16}

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("music-to-midi")

app = FastAPI(
    title="Music to MIDI",
    description="Spotify Basic Pitchを使ったローカル音声→MIDI変換アプリ",
    version="1.0.0",
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_MODEL: Any | None = None
_MODEL_LOCK = threading.Lock()


def settings_from_sensitivity(sensitivity: int) -> dict[str, float]:
    """Map the UI sensitivity control to Basic Pitch thresholds."""
    value = max(0, min(100, int(sensitivity)))
    return {
        "onset_threshold": round(0.75 - 0.0045 * value, 3),
        "frame_threshold": round(0.50 - 0.0025 * value, 3),
        "minimum_note_length": round(180.0 - value, 1),
    }


def clamp_bpm(value: float) -> float:
    if not math.isfinite(value):
        raise ValueError("BPM must be a finite number")
    return max(40.0, min(240.0, float(value)))


def safe_filename_stem(filename: str | None) -> str:
    stem = Path(filename or "audio").stem
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._")
    return (stem[:80] or "audio")


def _decode_audio(source_path: Path, wav_path: Path) -> None:
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", str(source_path),
        "-vn",
        "-ac", "1",
        "-ar", str(SAMPLE_RATE),
        "-t", str(MAX_AUDIO_SECONDS + 1),
        "-c:a", "pcm_s16le",
        str(wav_path),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=422, detail="音声のデコードがタイムアウトしました。") from exc

    if completed.returncode != 0 or not wav_path.exists():
        logger.warning("ffmpeg decode failed: %s", completed.stderr[-1500:])
        raise HTTPException(
            status_code=422,
            detail="音声を読み込めませんでした。対応形式の音声ファイルか確認してください。",
        )


def _estimate_bpm(audio: np.ndarray) -> float:
    if len(audio) < SAMPLE_RATE * 3 or float(np.max(np.abs(audio))) < 1e-5:
        return 120.0
    try:
        tempo, _ = librosa.beat.beat_track(y=audio, sr=SAMPLE_RATE, units="time")
        detected = float(np.asarray(tempo).reshape(-1)[0])
        if math.isfinite(detected) and 40.0 <= detected <= 240.0:
            return round(detected, 1)
    except Exception:
        logger.exception("BPM estimation failed; falling back to 120 BPM")
    return 120.0


def _get_model() -> Any:
    global _MODEL
    if _MODEL is None:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model

        _MODEL = Model(ICASSP_2022_MODEL_PATH)
    return _MODEL


def _convert_sync(
    source_path: Path,
    original_filename: str,
    output_path: Path,
    sensitivity: int,
    noise_reduction: int,
    tempo_mode: str,
    requested_bpm: float,
    time_signature_numerator: int,
    time_signature_denominator: int,
) -> dict[str, Any]:
    wav_path = output_path.with_suffix(".wav")
    _decode_audio(source_path, wav_path)

    try:
        info = sf.info(str(wav_path))
        duration = float(info.frames) / float(info.samplerate)
        if duration <= 0.05:
            raise HTTPException(status_code=422, detail="音声が短すぎるか、無音です。")
        if duration > MAX_AUDIO_SECONDS:
            raise HTTPException(
                status_code=413,
                detail="音源は6分以内にしてください。",
            )

        audio, sample_rate = sf.read(str(wav_path), dtype="float32", always_2d=False)
        if audio.ndim == 2:
            audio = np.mean(audio, axis=1, dtype=np.float32)
        if sample_rate != SAMPLE_RATE:
            audio = librosa.resample(
                audio,
                orig_sr=sample_rate,
                target_sr=SAMPLE_RATE,
            ).astype(np.float32, copy=False)
        if not np.all(np.isfinite(audio)) or float(np.max(np.abs(audio))) < 1e-5:
            raise HTTPException(status_code=422, detail="有効な音声信号を検出できませんでした。")

        if noise_reduction > 0:
            import noisereduce as nr

            audio = nr.reduce_noise(
                y=audio,
                sr=SAMPLE_RATE,
                stationary=True,
                prop_decrease=float(noise_reduction) / 100.0,
            ).astype(np.float32, copy=False)
            sf.write(str(wav_path), audio, SAMPLE_RATE, subtype="PCM_16")

        if tempo_mode == "auto":
            bpm = _estimate_bpm(audio)
        else:
            bpm = clamp_bpm(requested_bpm)

        thresholds = settings_from_sensitivity(sensitivity)

        from basic_pitch.inference import predict

        # The model may not be thread-safe. Serialize inference while allowing
        # uploads and audio decoding to happen concurrently.
        with _MODEL_LOCK:
            model = _get_model()
            _model_output, midi_data, _note_events = predict(
                str(wav_path),
                model_or_model_path=model,
                onset_threshold=thresholds["onset_threshold"],
                frame_threshold=thresholds["frame_threshold"],
                minimum_note_length=thresholds["minimum_note_length"],
                midi_tempo=bpm,
                multiple_pitch_bends=False,
                melodia_trick=True,
            )

        midi_data.time_signature_changes = [
            pretty_midi.TimeSignature(
                time_signature_numerator,
                time_signature_denominator,
                0.0,
            )
        ]
        midi_data.write(str(output_path))

        notes: list[dict[str, Any]] = []
        for instrument in midi_data.instruments:
            for note in instrument.notes:
                if note.end <= note.start:
                    continue
                notes.append(
                    {
                        "pitch": int(note.pitch),
                        "name": pretty_midi.note_number_to_name(int(note.pitch)),
                        "start": round(float(note.start), 4),
                        "end": round(float(note.end), 4),
                        "velocity": int(note.velocity),
                    }
                )
        notes.sort(key=lambda item: (item["start"], item["pitch"]))

        midi_bytes = output_path.read_bytes()
        return {
            "filename": safe_filename_stem(original_filename) + ".mid",
            "midi_base64": base64.b64encode(midi_bytes).decode("ascii"),
            "notes": notes,
            "note_count": len(notes),
            "duration": round(duration, 2),
            "bpm": round(float(bpm), 1),
            "time_signature": "{}/{}".format(
                time_signature_numerator,
                time_signature_denominator,
            ),
            "settings": {
                **thresholds,
                "noise_reduction": noise_reduction,
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Audio-to-MIDI conversion failed")
        raise HTTPException(
            status_code=500,
            detail="変換に失敗しました。Python環境とBasic Pitchのインストールを確認してください。",
        ) from exc


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "engine": "Spotify Basic Pitch"}


@app.post("/api/convert")
async def convert_audio(
    file: UploadFile = File(...),
    sensitivity: int = Form(65),
    noise_reduction: int = Form(0),
    tempo_mode: str = Form("auto"),
    bpm: float = Form(120.0),
    time_signature_numerator: int = Form(4),
    time_signature_denominator: int = Form(4),
) -> dict[str, Any]:
    filename = file.filename or "audio"
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail="対応形式は MP3 / WAV / FLAC / M4A / OGG / AIFF です。",
        )
    if not 0 <= sensitivity <= 100:
        raise HTTPException(status_code=422, detail="感度は0〜100で指定してください。")
    if not 0 <= noise_reduction <= 100:
        raise HTTPException(status_code=422, detail="ノイズ低減は0〜100で指定してください。")
    if tempo_mode not in {"auto", "manual"}:
        raise HTTPException(status_code=422, detail="BPMモードが不正です。")
    if time_signature_numerator not in range(1, 13):
        raise HTTPException(status_code=422, detail="拍子の分子は1〜12で指定してください。")
    if time_signature_denominator not in TIME_SIGNATURE_DENOMINATORS:
        raise HTTPException(status_code=422, detail="拍子の分母は1、2、4、8、16から選択してください。")
    try:
        requested_bpm = clamp_bpm(bpm)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="BPMは40〜240で指定してください。") from exc

    with tempfile.TemporaryDirectory(prefix="music-to-midi-") as temp_dir:
        temp_root = Path(temp_dir)
        source_path = temp_root / ("source" + suffix)
        output_path = temp_root / "result.mid"

        total_bytes = 0
        try:
            with source_path.open("wb") as target:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    total_bytes += len(chunk)
                    if total_bytes > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail="ファイルは50 MB以内にしてください。")
                    target.write(chunk)
        finally:
            await file.close()

        if total_bytes == 0:
            raise HTTPException(status_code=400, detail="ファイルが空です。")

        return await run_in_threadpool(
            _convert_sync,
            source_path,
            filename,
            output_path,
            sensitivity,
            noise_reduction,
            tempo_mode,
            requested_bpm,
            time_signature_numerator,
            time_signature_denominator,
        )
