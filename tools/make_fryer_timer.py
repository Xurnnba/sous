"""Render backend/sounds/fryer_alarm.wav: a mellow oven/fryer-timer beep.

Five 0.35 s beeps at 880 Hz (sine plus soft harmonics), one every 0.8 s, 4 s total, 16 kHz mono.
Chosen over the earlier ElevenLabs clip because that one read as a whistle / fire alarm (YAMNet:
Whistle 0.93, Alarm 0.71, Fire alarm 0.40), which both overlapped the phone ring ("Alarm") and could
alarm people during a live demo. This one is heard as "Beep, bleep" (~0.93) with no fire-alarm classes,
and is low and soft rather than shrill (smoke detectors sit near 3 kHz in a 3-beep pattern).

Run:  .venv/bin/python tools/make_fryer_timer.py
"""
from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

SR = 16000
OUT = Path(__file__).resolve().parents[1] / "backend" / "sounds" / "fryer_alarm.wav"


def beep(f: float = 880.0, dur: float = 0.35) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    x = np.sin(2 * np.pi * f * t) + 0.2 * np.sin(4 * np.pi * f * t) + 0.05 * np.sin(6 * np.pi * f * t)
    env = np.ones_like(t)
    a, r = int(0.008 * SR), int(0.03 * SR)
    env[:a] = np.linspace(0, 1, a)
    env[-r:] = np.linspace(1, 0, r)
    return x / np.max(np.abs(x)) * env


def render(total: float = 4.0) -> np.ndarray:
    y = np.zeros(int(total * SR))
    b = beep()
    for t0 in np.arange(0.1, 3.6, 0.8):
        i = int(t0 * SR)
        y[i:i + len(b)] += b
    return 0.5 * y / np.max(np.abs(y))


if __name__ == "__main__":
    y = render()
    with wave.open(str(OUT), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((y * 32767).astype("<i2").tobytes())
    print("wrote", OUT)
