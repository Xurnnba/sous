"""Sound library for the demo: realistic kitchen sound effects (ElevenLabs text-to-sound) that a judge
can play from a phone while the laptop listens. Also builds the test soundtrack from the same clips.

Files live in backend/sounds/<id>.wav (16 kHz mono). Each clip has the kitchen event it should
trigger, so the Ears page can show detections against ground truth.
"""
from __future__ import annotations

import io
import wave
from functools import lru_cache
from pathlib import Path

import numpy as np

SR = 16000
SOUND_DIR = Path(__file__).resolve().parents[3] / "sounds"

CLIPS = [
    {"id": "ticket_printer", "name": "Ticket printer", "kind": "ticket_burst", "emoji": "🧾",
     "hint": "An order printed off the POS"},
    {"id": "fryer_alarm", "name": "Fryer alarm", "kind": "fryer_alarm", "emoji": "🍟",
     "hint": "Fryer timer going off"},
    {"id": "door_chime", "name": "Door chime", "kind": "door_chime", "emoji": "🔔",
     "hint": "Someone at the front door"},
    {"id": "phone_ring", "name": "Phone ringing", "kind": "phone_ring", "emoji": "📞",
     "hint": "Landline order coming in"},
    {"id": "plates_crash", "name": "Plates crash", "kind": "clatter", "emoji": "🍽️",
     "hint": "Something dropped"},
]
BY_ID = {c["id"]: c for c in CLIPS}


def clip_path(cid: str) -> Path:
    return SOUND_DIR / f"{cid}.wav"


@lru_cache(maxsize=16)
def load_clip(cid: str) -> np.ndarray:
    with wave.open(str(clip_path(cid))) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    return x


def available() -> list[dict]:
    return [dict(c, available=clip_path(c["id"]).exists(), url=f"/api/sounds/{c['id']}.wav") for c in CLIPS]


# A 75 s test sequence built from the real clips, used for the "Play soundtrack" button and tests.
SCRIPT = [
    (3.0, "ticket_printer"), (9.0, "ticket_printer"), (16.0, "fryer_alarm"), (26.0, "door_chime"),
    (34.0, "ticket_printer"), (41.0, "phone_ring"), (50.0, "fryer_alarm"), (58.0, "door_chime"),
    (64.0, "plates_crash"), (70.0, "ticket_printer"),
]
DURATION = 78.0


def _bed(rng: np.random.Generator, n: int) -> np.ndarray:
    """Quiet kitchen room tone: hood fan rumble plus brown noise, about -42 dBFS."""
    white = rng.normal(0, 1, n)
    brown = np.cumsum(white)
    brown -= np.convolve(brown, np.ones(4000) / 4000, mode="same")
    brown /= np.max(np.abs(brown)) + 1e-9
    t = np.arange(n) / SR
    fan = 0.3 * np.sin(2 * np.pi * 93 * t) * (0.8 + 0.2 * np.sin(2 * np.pi * 0.3 * t))
    return 0.02 * (0.7 * brown + 0.3 * fan)


@lru_cache(maxsize=1)
def soundtrack_wav() -> bytes:
    rng = np.random.default_rng(42)
    n = int(DURATION * SR)
    mix = _bed(rng, n)
    for t0, cid in SCRIPT:
        if not clip_path(cid).exists():
            continue
        clip = load_clip(cid) * 0.7
        i = int(t0 * SR)
        j = min(n, i + len(clip))
        mix[i:j] += clip[: j - i]
    mix = np.clip(mix, -0.99, 0.99)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((mix * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def soundtrack_truth() -> dict:
    return {"duration_s": DURATION, "sample_rate": SR,
            "events": [{"t": t, "kind": BY_ID[cid]["kind"], "clip": cid} for t, cid in SCRIPT]}
