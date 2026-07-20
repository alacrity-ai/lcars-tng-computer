# tng-ear

The Computer's ears (Phase 3). Always-on local daemon:

1. openWakeWord custom "computer" model — continuous wake detection
2. On wake: trigger acknowledge chirp via the API server
3. Silero VAD capture, ~600–800ms silence endpoint
4. faster-whisper STT (local; Groq fallback)
5. POST `{transcript, confidence}` → bridge channel server → Claude session

Managed with `uv`. Note: WSL2 has no clean mic access — this daemon may run
natively on Windows instead (decision tracked in TNGC-5 / DESIGN.md §3.2).
