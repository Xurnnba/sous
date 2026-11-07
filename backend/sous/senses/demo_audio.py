"""Synthesises a 75-second kitchen soundtrack with known event timestamps.

The frontend plays it through the speakers *and* streams the PCM to the classifier, so the demo
does not depend on the room being quiet. The JSON ground truth lets judges compare what the
ears detected against what was actually there.
"""
from __future__ import annotations

import io
import json
import wave
from functools import lru_cache

import numpy as np

SR = 16000
DURATION = 75.0

# (time_s, kind)
SCRIPT = [
    (3.0, "ticket_burst"), (5.2, "ticket_burst"), (7.6, "ticket_burst"), (10.0, "ticket_burst"),
    (18.0, "fryer_alarm"),
    (30.0, "door_chime"),
    (40.0, "ticket_burst"), (42.6, "ticket_burst"),
    (48.0, "fryer_alarm"),
    (58.0, "door_chime"),
    (62.5, "noise_spike"),
    (70.0, "ticket_burst"),
]


def _env(n: int, attack: float, release: float) -> np.ndarray:
    a, r = int(attack * SR), int(release * SR)
    e = np.ones(n)
    e[:a] = np.linspace(0, 1, a)
    e[-r:] = np.linspace(1, 0, r)
    return e


def _ticket_burst(rng: np.random.Generator) -> np.ndarray:
    dur = rng.uniform(1.0, 1.6)
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    # thermal head stepping: ~14 Hz amplitude modulation, plus a 1.2 kHz-ish mechanical resonance
    am = 0.55 + 0.45 * np.sign(np.sin(2 * np.pi * 14 * t))
    tone = 0.15 * np.sin(2 * np.pi * 1180 * t)
    # band-limit the noise a bit (one-pole highpass + lowpass)
    hp = np.concatenate([[0], noise[1:] - 0.85 * noise[:-1]])
    x = (hp * 0.6 + tone) * am * _env(n, 0.02, 0.05)
    return 0.35 * x / (np.max(np.abs(x)) + 1e-9)


def _fryer_alarm(rng: np.random.Generator) -> np.ndarray:
    beeps, on, off = 4, 0.55, 0.18
    f = 2850.0
    parts = []
    for _ in range(beeps):
        n = int(on * SR)
        t = np.arange(n) / SR
        parts.append(np.sin(2 * np.pi * f * t) * _env(n, 0.005, 0.02))
        parts.append(np.zeros(int(off * SR)))
    return 0.6 * np.concatenate(parts)


def _door_chime(rng: np.random.Generator) -> np.ndarray:
    out = []
    for f, start in ((1046.5, 0.0), (784.0, 0.45)):
        n = int(1.2 * SR)
        t = np.arange(n) / SR
        tone = np.sin(2 * np.pi * f * t) * np.exp(-t * 3.2) + 0.3 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 6)
        pad = np.zeros(int(start * SR))
        out.append(np.concatenate([pad, tone]))
    n = max(len(o) for o in out)
    mix = sum(np.pad(o, (0, n - len(o))) for o in out)
    return 0.55 * mix / (np.max(np.abs(mix)) + 1e-9)


def _clatter(rng: np.random.Generator) -> np.ndarray:
    n = int(0.9 * SR)
    noise = rng.normal(0, 1, n)
    hits = np.zeros(n)
    for h in rng.uniform(0, 0.7, 6):
        i = int(h * SR)
        hits[i:i + 800] += np.exp(-np.arange(800) / 150)
    x = noise * (0.3 + hits)
    return 0.8 * x / (np.max(np.abs(x)) + 1e-9)


def _bed(rng: np.random.Generator, n: int) -> np.ndarray:
    """Kitchen room tone: brown-ish noise with a slow hood-fan rumble and sporadic bubbling."""
    white = rng.normal(0, 1, n)
    brown = np.cumsum(white)
    brown -= np.convolve(brown, np.ones(4000) / 4000, mode="same")
    brown /= np.max(np.abs(brown)) + 1e-9
    t = np.arange(n) / SR
    fan = 0.4 * np.sin(2 * np.pi * 93 * t) + 0.2 * np.sin(2 * np.pi * 186 * t)
    x = 0.6 * brown + 0.4 * fan * (0.8 + 0.2 * np.sin(2 * np.pi * 0.3 * t))
    return 0.025 * x  # about -40 dBFS


@lru_cache(maxsize=1)
def soundtrack_wav() -> bytes:
    rng = np.random.default_rng(42)
    n = int(DURATION * SR)
    mix = _bed(rng, n)
    gens = {"ticket_burst": _ticket_burst, "fryer_alarm": _fryer_alarm,
            "door_chime": _door_chime, "noise_spike": _clatter}
    for t0, kind in SCRIPT:
        clip = gens[kind](rng)
        i = int(t0 * SR)
        j = min(n, i + len(clip))
        mix[i:j] += clip[: j - i]
    mix = np.clip(mix, -0.99, 0.99)
    pcm = (mix * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    return buf.getvalue()


def soundtrack_truth() -> dict:
    return {"duration_s": DURATION, "sample_rate": SR,
            "events": [{"t": t, "kind": k} for t, k in SCRIPT]}


if __name__ == "__main__":
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else "soundtrack.wav"
    with open(path, "wb") as f:
        f.write(soundtrack_wav())
    print(json.dumps(soundtrack_truth(), indent=1))
