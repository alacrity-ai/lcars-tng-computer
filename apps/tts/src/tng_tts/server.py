"""TNG Computer TTS sidecar.

POST /synth {"text": "..."} -> audio/wav
GET  /health                -> {"ok": true, "engine": "...", "voice": "..."}

Engine is selected by TNG_TTS_ENGINE (default "piper"). The Qwen3 engine is the
Majel-clone slot (TNGC-4): once reference audio exists under voice/reference and
the model is installed, set TNG_TTS_ENGINE=qwen3. The Node server treats this
sidecar as optional — if it's down, the display falls back to captions.
"""

from __future__ import annotations

import io
import os
import wave
from abc import ABC, abstractmethod
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

REPO_ROOT = Path(__file__).resolve().parents[4]
PIPER_DATA_DIR = Path(os.environ.get("TNG_TTS_PIPER_DIR", REPO_ROOT / "voice" / "piper"))
PIPER_VOICE = os.environ.get("TNG_TTS_PIPER_VOICE", "en_US-lessac-medium")
ENGINE = os.environ.get("TNG_TTS_ENGINE", "piper")


class Engine(ABC):
    name: str
    voice: str

    @abstractmethod
    def synth(self, text: str) -> bytes:
        """Return a complete WAV file for the given text."""


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

    def synth(self, text: str) -> bytes:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            self._voice.synthesize_wav(text, wav)
        return buf.getvalue()


class Qwen3Engine(Engine):
    """Majel-clone slot — wired up when the reference clips + model land (TNGC-4)."""

    name = "qwen3"

    def __init__(self) -> None:
        raise RuntimeError(
            "Qwen3-TTS engine not yet configured. Needs: cleaned reference clips in "
            "voice/reference/, the Qwen3-TTS model installed, and clone setup. "
            "See TNGC-4 / DESIGN.md §6."
        )

    def synth(self, text: str) -> bytes:  # pragma: no cover
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
def synth(req: SynthRequest) -> Response:
    if _engine is None:
        raise HTTPException(503, "engine not loaded")
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text is required")
    return Response(content=_engine.synth(text), media_type="audio/wav")


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TNG_TTS_PORT", "3790")))


if __name__ == "__main__":
    main()
