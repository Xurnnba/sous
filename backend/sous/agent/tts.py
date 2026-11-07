"""Server-side voice.

Order of preference for a line of text:
1. ``voice_cache/<sha1(text)>.mp3`` — pre-rendered ElevenLabs clips for the demo's fixed lines
   (rendered with the "Deon M" assistant voice; see tools/render_voice_cache.py).
2. ElevenLabs API, if ELEVENLABS_API_KEY is set; the result is written into the cache.
3. ``None`` → the line is shown on screen but not spoken (the browser voice is never used).

So the signature moments of the demo sound the same with or without a key, and with a key every
line does.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Optional

import httpx

CACHE_DIR = Path(__file__).resolve().parents[2] / "voice_cache"
CACHE_DIR.mkdir(exist_ok=True)

_ELEVEN_KEY = os.environ.get("ELEVENLABS_API_KEY")
# "Deon M – Calm, Composed AI Assistant": even tone whether confirming or flagging a problem.
_ELEVEN_VOICE = os.environ.get("ELEVENLABS_VOICE_ID", "MVc9udK5w93ZDKCXnhBy")
_ELEVEN_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_turbo_v2_5")

PROVIDER = "elevenlabs" if _ELEVEN_KEY else ("cache" if any(CACHE_DIR.glob("*.mp3")) else "none")


def cache_key(text: str) -> str:
    return hashlib.sha1(text.strip().lower().encode()).hexdigest()


def cached(text: str) -> Optional[bytes]:
    p = CACHE_DIR / f"{cache_key(text)}.mp3"
    return p.read_bytes() if p.exists() else None


async def synthesize(text: str) -> Optional[bytes]:
    hit = cached(text)
    if hit:
        return hit
    if not _ELEVEN_KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            r = await c.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{_ELEVEN_VOICE}",
                headers={"xi-api-key": _ELEVEN_KEY, "accept": "audio/mpeg"},
                json={"text": text, "model_id": _ELEVEN_MODEL,
                      "voice_settings": {"stability": 0.55, "similarity_boost": 0.75}},
            )
            if r.status_code == 200:
                (CACHE_DIR / f"{cache_key(text)}.mp3").write_bytes(r.content)
                return r.content
    except Exception:
        return None
    return None
