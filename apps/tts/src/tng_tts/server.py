"""TTS sidecar for tng-computer.

POST /synth {"text": "...", "lang": "fr"} -> {"audio": base64(wav), "timing": [...], "engine": "...", "voice": "..."}
GET  /health                              -> {"ok": true, "engine": "...", "voice": "...", "languages": [...]}

Engine is selected by TNG_TTS_ENGINE (default "piper"). The Qwen3 engine is the
Majel-clone slot (TNGC-4): once reference audio exists under voice/reference and
the model is installed, set TNG_TTS_ENGINE=qwen3. The Node server treats this
sidecar as optional — if it's down, the display falls back to captions.

Languages: `lang` is an ISO 639-1 code (default "en"). Piper maps it to a
native voice model (PIPER_LANG_VOICES, overridable per language via
TNG_TTS_PIPER_VOICE_<LANG>). A voice not yet on disk downloads in the
background while the request falls back to the default English voice — the
first utterance in a new language is accented, never silent or slow. Qwen3 is
natively multilingual and will ignore the voice map.

Timing data: character-level durations extracted from phoneme timings, used for
karaoke-mode highlighting in the display.
"""

from __future__ import annotations

import base64
import io
import os
import re
import subprocess
import sys
import threading
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

# ISO 639-1 -> Piper voice model. The default English voice comes from
# TNG_TTS_PIPER_VOICE; any language here can be overridden with
# TNG_TTS_PIPER_VOICE_<LANG> (e.g. TNG_TTS_PIPER_VOICE_FR=fr_FR-upmc-medium).
# Unlisted languages fall back to the English voice.
PIPER_LANG_VOICES: dict[str, str] = {
    "en": PIPER_VOICE,
    "ar": "ar_JO-kareem-medium",
    "bg": "bg_BG-dimitar-medium",
    "bn": "bn_BD-google-medium",
    "ca": "ca_ES-upc_ona-medium",
    "cs": "cs_CZ-jirka-medium",
    "cy": "cy_GB-bu_tts-medium",
    "da": "da_DK-talesyntese-medium",
    "de": "de_DE-thorsten-medium",
    "el": "el_GR-rapunzelina-low",
    "es": "es_ES-davefx-medium",
    "eu": "eu_ES-maider-medium",
    "fa": "fa_IR-amir-medium",
    "fi": "fi_FI-harri-medium",
    "fr": "fr_FR-siwis-medium",
    "hi": "hi_IN-pratham-medium",
    "hu": "hu_HU-anna-medium",
    "id": "id_ID-news_tts-medium",
    "is": "is_IS-steinn-medium",
    "it": "it_IT-paola-medium",
    "ka": "ka_GE-natia-medium",
    "kk": "kk_KZ-issai-high",
    "ku": "ku_TR-berfin_renas-medium",
    "lb": "lb_LU-marylux-medium",
    "lv": "lv_LV-aivars-medium",
    "ml": "ml_IN-meera-medium",
    "ne": "ne_NP-chitwan-medium",
    "nl": "nl_BE-nathalie-medium",
    "no": "no_NO-talesyntese-medium",
    "pl": "pl_PL-darkman-medium",
    "pt": "pt_BR-faber-medium",
    "ro": "ro_RO-mihai-medium",
    "ru": "ru_RU-dmitri-medium",
    "sk": "sk_SK-lili-medium",
    "sl": "sl_SI-artur-medium",
    "sq": "sq_AL-edon-medium",
    "sr": "sr_RS-serbski_institut-medium",
    "sv": "sv_SE-nst-medium",
    "sw": "sw_CD-lanfrica-medium",
    "te": "te_IN-maya-medium",
    "tr": "tr_TR-fahrettin-medium",
    "uk": "uk_UA-ukrainian_tts-medium",
    "ur": "ur_PK-fasih-medium",
    "vi": "vi_VN-vais1000-medium",
    "zh": "zh_CN-huayan-medium",
}
for _lang in list(PIPER_LANG_VOICES):
    _override = os.environ.get(f"TNG_TTS_PIPER_VOICE_{_lang.upper()}")
    if _override:
        PIPER_LANG_VOICES[_lang] = _override


def _norm_lang(lang: str | None) -> str:
    """'fr-FR' / 'FR' / ' fr ' -> 'fr'; empty/None -> 'en'."""
    return (lang or "en").strip().lower().split("-")[0] or "en"


def _sentence_spans(text: str) -> list[tuple[int, int]]:
    """Split text into contiguous (start, end) sentence spans.

    Spans cover every character exactly once (trailing whitespace belongs to
    the preceding sentence), so per-span timings tile the whole input. CJK
    enders (。！？) close a sentence without requiring trailing whitespace.
    """
    spans: list[tuple[int, int]] = []
    start = 0
    for m in re.finditer(r"[.!?]+[\)\"”’']*\s+|[。！？]+", text):
        spans.append((start, m.end()))
        start = m.end()
    if start < len(text):
        spans.append((start, len(text)))
    return spans or [(0, len(text))]


class Engine(ABC):
    name: str
    voice: str

    @abstractmethod
    def synth_segments(self, segments: list[dict]) -> tuple[bytes, list[dict], str]:
        """Synthesize [{"text": ..., "lang": ...}] as ONE utterance.

        Each segment uses its language's voice; audio is stitched in order.
        Returns (audio_wav, timing_data, voices_used).

        timing_data: [{"char": 0, "duration_ms": 120}, ...]
        Character index is 0-based position in the CONCATENATED text, so
        karaoke highlighting tiles the full utterance.
        """

    def synth(self, text: str, lang: str = "en") -> tuple[bytes, list[dict], str]:
        return self.synth_segments([{"text": text, "lang": lang}])


class PiperEngine(Engine):
    name = "piper"

    def __init__(self) -> None:
        from piper import PiperVoice

        self._PiperVoice = PiperVoice
        self._voices: dict[str, object] = {}  # voice name -> loaded PiperVoice
        self._lock = threading.Lock()
        self._downloading: set[str] = set()

        # The default (English) voice is required at boot — it is also the
        # fallback while any other language's model is still downloading.
        default = self._load(PIPER_VOICE)
        if default is None:
            raise RuntimeError(
                f"Piper voice model missing: {PIPER_DATA_DIR / (PIPER_VOICE + '.onnx')}\n"
                f"Download it with:\n"
                f"  uv run --project apps/tts python -m piper.download_voices "
                f"{PIPER_VOICE} --data-dir {PIPER_DATA_DIR}"
            )
        self.voice = PIPER_VOICE

    # Pause inserted between separately-synthesized sentences; included in the
    # measured durations so timing and audio can never disagree.
    SENTENCE_SILENCE_MS = 220

    def _load(self, voice_name: str):
        """Return the loaded PiperVoice, or None if its model isn't on disk."""
        with self._lock:
            cached = self._voices.get(voice_name)
        if cached is not None:
            return cached
        model = PIPER_DATA_DIR / f"{voice_name}.onnx"
        if not model.exists():
            return None
        loaded = self._PiperVoice.load(str(model))
        with self._lock:
            self._voices[voice_name] = loaded
        return loaded

    def _download_in_background(self, voice_name: str) -> None:
        """Fetch a voice model without blocking synthesis; dedup concurrent asks."""
        with self._lock:
            if voice_name in self._downloading:
                return
            self._downloading.add(voice_name)

        def run() -> None:
            try:
                subprocess.run(
                    [sys.executable, "-m", "piper.download_voices", voice_name,
                     "--data-dir", str(PIPER_DATA_DIR)],
                    check=True, capture_output=True, timeout=600,
                )
                print(f"[tts] voice ready: {voice_name}", flush=True)
            except Exception as err:  # offline, bad name, … — stay on fallback
                print(f"[tts] voice download failed: {voice_name}: {err}", flush=True)
            finally:
                with self._lock:
                    self._downloading.discard(voice_name)

        threading.Thread(target=run, daemon=True, name=f"piper-dl-{voice_name}").start()

    def _voice_for(self, lang: str):
        """Resolve lang to a loaded voice; kick off a download and fall back to
        the default voice when the native model isn't available yet."""
        voice_name = PIPER_LANG_VOICES.get(_norm_lang(lang), PIPER_VOICE)
        loaded = self._load(voice_name)
        if loaded is None:
            self._download_in_background(voice_name)
            return self._voices[PIPER_VOICE], PIPER_VOICE
        return loaded, voice_name

    def _synth_text(self, voice, text: str) -> tuple[np.ndarray, list[dict], int]:
        """Synthesize per sentence and measure real durations from the audio.

        Each sentence's duration_ms comes from its actual sample count, so the
        highlight is exact at every sentence boundary. Within a sentence,
        characters share the measured duration evenly — any drift there
        self-corrects when the next sentence starts.

        Returns (audio_samples, timing, sample_rate) at the voice's native rate.
        """
        rate = getattr(getattr(voice, "config", None), "sample_rate", 22050)
        timing: list[dict] = []
        audio_parts: list[np.ndarray] = []

        for start, end in _sentence_spans(text):
            arrs = [chunk.audio_int16_array for chunk in voice.synthesize(text[start:end])]
            if arrs:
                rate = getattr(voice.config, "sample_rate", rate)
            audio = np.concatenate(arrs) if arrs else np.zeros(0, dtype=np.int16)
            if end < len(text):
                pause = np.zeros(int(rate * self.SENTENCE_SILENCE_MS / 1000), dtype=np.int16)
                audio = np.concatenate([audio, pause])

            duration_ms = len(audio) / rate * 1000
            per_char = duration_ms / max(1, end - start)
            timing.extend({"char": i, "duration_ms": per_char} for i in range(start, end))
            audio_parts.append(audio)

        full = np.concatenate(audio_parts) if audio_parts else np.zeros(0, dtype=np.int16)
        return full, timing, rate

    @staticmethod
    def _resample(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
        """Linear resample so segments from different-rate voices can be
        stitched into one WAV. Duration (and thus timing) is preserved."""
        if src_rate == dst_rate or len(audio) == 0:
            return audio
        n = int(round(len(audio) * dst_rate / src_rate))
        positions = np.linspace(0, len(audio) - 1, n)
        return np.interp(positions, np.arange(len(audio)), audio.astype(np.float32)).astype(np.int16)

    def synth_segments(self, segments: list[dict]) -> tuple[bytes, list[dict], str]:
        """Each segment speaks in its language's voice; audio is stitched in
        order at the default voice's sample rate. Char timing is offset into
        the concatenated text so the caption highlight spans voice changes."""
        default_voice = self._voices[PIPER_VOICE]
        target_rate = getattr(getattr(default_voice, "config", None), "sample_rate", 22050)

        timing: list[dict] = []
        audio_parts: list[np.ndarray] = []
        voices_used: list[str] = []
        offset = 0

        for seg in segments:
            voice, voice_name = self._voice_for(seg.get("lang", "en"))
            audio, seg_timing, rate = self._synth_text(voice, seg["text"])
            audio_parts.append(self._resample(audio, rate, target_rate))
            timing.extend(
                {"char": offset + t["char"], "duration_ms": t["duration_ms"]} for t in seg_timing
            )
            voices_used.append(voice_name)
            offset += len(seg["text"])

        full = np.concatenate(audio_parts) if audio_parts else np.zeros(0, dtype=np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(target_rate)
            wav.writeframes(full.tobytes())
        return buf.getvalue(), timing, "+".join(dict.fromkeys(voices_used))


class Qwen3Engine(Engine):
    """Majel-clone slot — wired up when the reference clips + model land (TNGC-4).
    Natively multilingual: one cloned voice for every lang, no voice map."""

    name = "qwen3"

    def __init__(self) -> None:
        raise RuntimeError(
            "Qwen3-TTS engine not yet configured. Needs: cleaned reference clips in "
            "voice/reference/, the Qwen3-TTS model installed, and clone setup. "
            "See TNGC-4 / DESIGN.md §6."
        )

    def synth_segments(self, segments: list[dict]) -> tuple[bytes, list[dict], str]:  # pragma: no cover
        raise NotImplementedError


ENGINES = {"piper": PiperEngine, "qwen3": Qwen3Engine}


class SynthSegment(BaseModel):
    text: str
    lang: str = "en"


class SynthRequest(BaseModel):
    text: str | None = None
    lang: str = "en"
    # Mixed-language utterance: overrides text/lang when present. Segments are
    # stitched into one utterance, each spoken by its language's voice.
    segments: list[SynthSegment] | None = None


app = FastAPI(title="tng-tts")
_engine: Engine | None = None


@app.on_event("startup")
def load_engine() -> None:
    global _engine
    _engine = ENGINES[ENGINE]()


@app.get("/health")
def health() -> dict:
    return {
        "ok": _engine is not None,
        "engine": ENGINE,
        "voice": getattr(_engine, "voice", None),
        "languages": sorted(PIPER_LANG_VOICES) if ENGINE == "piper" else None,
    }


@app.post("/synth")
def synth(req: SynthRequest) -> JSONResponse:
    if _engine is None:
        raise HTTPException(503, "engine not loaded")

    if req.segments:
        # Preserve exact text (including whitespace) — timing tiles the
        # concatenation, so the caller's joined caption must match char-for-char.
        segments = [{"text": s.text, "lang": _norm_lang(s.lang)} for s in req.segments if s.text]
    else:
        text = (req.text or "").strip()
        if not text:
            raise HTTPException(400, "text or segments is required")
        segments = [{"text": text, "lang": _norm_lang(req.lang)}]

    audio_bytes, timing, voice = _engine.synth_segments(segments)
    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

    return JSONResponse({
        "audio": audio_b64,
        "timing": timing,
        "engine": _engine.name,
        "voice": voice,
    })


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TNG_TTS_PORT", "3790")))


if __name__ == "__main__":
    main()
