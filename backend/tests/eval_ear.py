"""Reproducible evaluation of the ears.

Builds the demo soundtrack from the real sound clips, degrades it the way a room would (distance
attenuation, reverb, background noise), and measures recall / false positives for:
  1. zero-shot (AudioSet priors only, no calibration)
  2. few-shot after teaching each sound once *through the same room* (the real owner flow)
  3. few-shot in a different, noisier room than the one it was taught in

Run:  ../.venv/bin/python tests/eval_ear.py
"""
from __future__ import annotations

import io
import os
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sous.senses.ear import embedder, sounds  # noqa: E402
from sous.senses.ear.classifier import EarClassifier, PrototypeStore, BACKGROUND  # noqa: E402

SR = 16000


def room(x: np.ndarray, att_db: float, noise_db: float, rt: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n_ir = int(rt * SR)
    ir = rng.normal(0, 1, n_ir) * np.exp(-np.arange(n_ir) / (n_ir / 6))
    ir[0] = 1.0
    ir /= np.sqrt((ir ** 2).sum())
    y = np.convolve(x, ir)[: len(x)] * 10 ** (att_db / 20)
    y = y + rng.normal(0, 1, len(y)) * 10 ** (noise_db / 20)
    return np.clip(y, -1, 1)


def feed(c: EarClassifier, sig: np.ndarray, events: list) -> None:
    pcm = (sig * 32767).astype("<i2").tobytes()
    for i in range(0, len(pcm), 8000):
        n = len(events)
        c.feed_int16(pcm[i: i + 8000])
        for e in events[n:]:
            e["_t"] = round(c.t, 2)


def score(events: list, truth: list, name: str, t0: float) -> tuple[int, int]:
    used = set()
    tp = 0
    for tr in truth:
        m = [e for e in events if e["kind"] == tr["kind"] and -0.5 <= e["_t"] - tr["t"] <= 4.0 and id(e) not in used]
        if m:
            tp += 1
            used.add(id(m[0]))
    fp = len(events) - tp
    print(f"{name:44s} recall {tp:2d}/{len(truth)}  false positives {fp:2d}   ({time.time() - t0:.1f}s)")
    for e in events:
        ok = "✓" if id(e) in used else "✗"
        print(f"      {ok} {e['_t']:5.1f}s {e['kind']:13s} {e['data']['how']:9s} conf {e['data']['confidence']:.2f} "
              f"top={e['data']['top'][0][0]}")
    return tp, fp


def teach_through_room(store: PrototypeStore, att_db: float, noise_db: float, rt: float, seed: int) -> None:
    """The owner flow: play each sound once near the mic, press 'teach'."""
    c = EarClassifier("teach", "kitchen", store, lambda e: None)
    rng = np.random.default_rng(seed)
    # let it hear the room first so background prototypes exist
    bed = room(sounds._bed(rng, 12 * SR) * 0 + rng.normal(0, 1, 12 * SR) * 0.002, 0, noise_db, rt, seed)
    feed(c, bed, [])
    for clip in sounds.CLIPS:
        x = sounds.load_clip(clip["id"])
        pad = np.zeros(int(0.5 * SR))
        sig = room(np.concatenate([pad, x, x, pad]), att_db, noise_db, rt, seed + 1)
        c.start_teach(clip["kind"], seconds=len(sig) / SR)
        feed(c, sig, [])
        c._finish_teach()


def main() -> int:
    embedder.load()
    print("model:", embedder.status())
    with wave.open(io.BytesIO(sounds.soundtrack_wav())) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    truth = sounds.soundtrack_truth()["events"]
    tmp = Path(tempfile.mkdtemp())

    print("\nWhat YAMNet calls each clip (clean, zero-shot):")
    for clip in sounds.CLIPS:
        out = embedder.embed(sounds.load_clip(clip["id"]))
        names = embedder.class_names()
        top = np.argsort(out[0])[::-1][:3]
        print(f"  {clip['name']:15s} -> " + ", ".join(f"{names[i]} {out[0][i]:.2f}" for i in top))

    results = {}
    for name, sig in [("zero-shot · clean", x),
                      ("zero-shot · room 4 m (-18 dB, RT 0.3 s)", room(x, -18, -46, 0.3, 1))]:
        ev = []
        c = EarClassifier("m", "kitchen", PrototypeStore(tmp / f"{len(results)}.json"), lambda e: ev.append(e))
        t0 = time.time()
        feed(c, sig, ev)
        results[name] = score(ev, truth, name, t0)

    store = PrototypeStore(tmp / "taught.json")
    teach_through_room(store, -18, -46, 0.3, 7)
    print("\ntaught:", [(p["label"], p["examples"]) for p in store.summary()])
    for name, sig in [("few-shot · same room, later (-18 dB)", room(x, -18, -46, 0.3, 2)),
                      ("few-shot · farther + noisier (-26 dB, -42 dB)", room(x, -26, -42, 0.4, 3)),
                      ("few-shot · across the room (-32 dB, -42 dB)", room(x, -32, -42, 0.5, 4))]:
        ev = []
        c = EarClassifier("m", "kitchen", store, lambda e: ev.append(e))
        t0 = time.time()
        feed(c, sig, ev)
        results[name] = score(ev, truth, name, t0)

    print("\nSUMMARY")
    for k, (tp, fp) in results.items():
        print(f"  {k:44s} recall {tp}/{len(truth)}  fp {fp}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
