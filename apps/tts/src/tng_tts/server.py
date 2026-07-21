"""TTS sidecar for tng-computer.

POST /synth {"text": "..."} -> {"audio": base64(wav), "timing": [...], "engine": "..."}
GET  /health                -> {"ok": true, "engine": "...", "voice": "..."}

Engine is selected by TNG_TTS_ENGINE (default "piper"). The Qwen3 engine is the
Majel-clone slot (TNGC-4): once reference audio exists under voice/reference and
the model is installed, set TNG_TTS_ENGINE=qwen3. The Node server treats this
sidecar as optional — if it's down, the display falls back to captions.

Timing data: character-level durations extracted from phoneme timings, used for
karaoke-mode highlighting in the display.
"""

from __future__ import annotations

import base64
import io
import os
import re
import wave
from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

REPO_ROOT = Path(__file__).resolve().parents[4]
PIPER_DATA_DIR = Path(os.environ.get("TNG_TTS_PIPER_DIR", REPO_ROOT / "voice" / "piper"))
PIPER_VOICE = os.environ.get("TNG_TTS_PIPER_VOICE", "en_US-lessac-medium")
ENGINE = os.environ.get("TNG_TTS_ENGINE", "piper")


def _sentence_spans(text: str) -> list[tuple[int, int]]:
    """Split text into contiguous (start, end) sentence spans.

    Spans cover every character exactly once (trailing whitespace belongs to
    the preceding sentence), so per-span timings tile the whole input.
    """
    spans: list[tuple[int, int]] = []
    start = 0
    for m in re.finditer(r"[.!?]+[\)\"”’']*\s+", text):
        spans.append((start, m.end()))
        start = m.end()
    if start < len(text):
        spans.append((start, len(text)))
    return spans or [(0, len(text))]


class Engine(ABC):
    name: str
    voice: str

    @abstractmethod
    def synth(self, text: str) -> tuple[bytes, list[dict]]:
        """Return (audio_wav, timing_data).

        timing_data: [{"char": 0, "duration_ms": 120}, ...]
        Character index is 0-based position in the original text.
        """


class PiperEngine(Engine):
    name = "piper"

    def __init__(self) -> None:
        from piper import PiperVoice

        model = PIPER_DATA_DIR / f"{PIPER_VOICE}.onnx"
        if not model.exists():
            raise RuntimeError(
                f"Piper voice model missing: {model}\n"
                f"Download it with:\n"
                f"  uv run --project apps/tts python -m piper.download_voices "
                f"{PIPER_VOICE} --data-dir {PIPER_DATA_DIR}"
            )
        self.voice = PIPER_VOICE
        self._voice = PiperVoice.load(str(model))

    # Pause inserted between separately-synthesized sentences; included in the
    # measured durations so timing and audio can never disagree.
    SENTENCE_SILENCE_MS = 220

    def synth(self, text: str) -> tuple[bytes, list[dict]]:
        """Synthesize per sentence and measure real durations from the audio.

        Each sentence's duration_ms comes from its actual sample count, so the
        highlight is exact at every sentence boundary. Within a sentence,
        characters share the measured duration evenly — any drift there
        self-corrects when the next sentence starts.
        """
        rate = getattr(getattr(self._voice, "config", None), "sample_rate", 22050)
        timing: list[dict] = []
        audio_parts: list[np.ndarray] = []

        for start, end in _sentence_spans(text):
            arrs = [chunk.audio_int16_array for chunk in self._voice.synthesize(text[start:end])]
            if arrs:
                rate = getattr(self._voice.config, "sample_rate", rate)
            audio = np.concatenate(arrs) if arrs else np.zeros(0, dtype=np.int16)
            if end < len(text):
                pause = np.zeros(int(rate * self.SENTENCE_SILENCE_MS / 1000), dtype=np.int16)
                audio = np.concatenate([audio, pause])

            duration_ms = len(audio) / rate * 1000
            per_char = duration_ms / max(1, end - start)
            timing.extend({"char": i, "duration_ms": per_char} for i in range(start, end))
            audio_parts.append(audio)

        full = np.concatenate(audio_parts) if audio_parts else np.zeros(0, dtype=np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes(full.tobytes())
        return buf.getvalue(), timing


class Qwen3Engine(Engine):
    """Majel-clone slot — wired up when the reference clips + model land (TNGC-4)."""

    name = "qwen3"

    def __init__(self) -> None:
        raise RuntimeError(
            "Qwen3-TTS engine not yet configured. Needs: cleaned reference clips in "
            "voice/reference/, the Qwen3-TTS model installed, and clone setup. "
            "See TNGC-4 / DESIGN.md §6."
        )

    def synth(self, text: str) -> tuple[bytes, list[dict]]:  # pragma: no cover
        raise NotImplementedError


ENGINES = {"piper": PiperEngine, "qwen3": Qwen3Engine}


class SynthRequest(BaseModel):
    text: str


app = FastAPI(title="tng-tts")
_engine: Engine | None = None


@app.on_event("startup")
def load_engine() -> None:
    global _engine
    _engine = ENGINES[ENGINE]()


@app.get("/health")
def health() -> dict:
    return {"ok": _engine is not None, "engine": ENGINE, "voice": getattr(_engine, "voice", None)}


@app.post("/synth")
def synth(req: SynthRequest) -> JSONResponse:
    if _engine is None:
        raise HTTPException(503, "engine not loaded")
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text is required")

    audio_bytes, timing = _engine.synth(text)
    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

    return JSONResponse({
        "audio": audio_b64,
        "timing": timing,
        "engine": _engine.name
    })


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TNG_TTS_PORT", "3790")))


if __name__ == "__main__":
    main()
