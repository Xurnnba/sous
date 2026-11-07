"""Sweep the ear classifier's tunables over the room scenarios in eval_ear and print a ranking.
Score = total recall - total false positives across the few-shot scenarios + zero-shot room."""
from __future__ import annotations

import io
import itertools
import os
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sous.senses.ear import classifier as C, embedder, sounds  # noqa: E402
from eval_ear import feed, room, teach_through_room  # noqa: E402


def run(cfg: dict) -> tuple[int, int, list]:
    C.CFG.update(cfg)
    with wave.open(io.BytesIO(sounds.soundtrack_wav())) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    truth = sounds.soundtrack_truth()["events"]
    tmp = Path(tempfile.mkdtemp())
    store = C.PrototypeStore(tmp / "t.json")
    teach_through_room(store, -18, -46, 0.3, 7)
    scen = [("zs-room", room(x, -18, -46, 0.3, 1), C.PrototypeStore(tmp / "e.json")),
            ("same", room(x, -18, -46, 0.3, 2), store),
            ("noisy", room(x, -26, -42, 0.4, 3), store),
            ("far", room(x, -32, -42, 0.5, 4), store)]
    TP = FP = 0
    detail = []
    for name, sig, st in scen:
        ev: list = []
        c = C.EarClassifier("m", "kitchen", st, lambda e: ev.append(e))
        feed(c, sig, ev)
        used = set()
        tp = 0
        for tr in truth:
            m = [e for e in ev if e["kind"] == tr["kind"] and -0.5 <= e["_t"] - tr["t"] <= 4.0 and id(e) not in used]
            if m:
                tp += 1
                used.add(id(m[0]))
        fp = len(ev) - tp
        TP += tp
        FP += fp
        detail.append(f"{name}:{tp}/{len(truth)}-{fp}")
    return TP, FP, detail


def main() -> None:
    embedder.load()
    grid = {
        "gate": [True, False],
        "knn_k": [1, 3, 5],
        "few_thr": [0.66, 0.70, 0.74],
        "confirm": [{}, {"fryer_alarm": 2, "ticket_burst": 2, "phone_ring": 2}],
    }
    results = []
    keys = list(grid)
    for combo in itertools.product(*(grid[k] for k in keys)):
        cfg = dict(zip(keys, combo))
        tp, fp, detail = run(cfg)
        results.append((tp - fp, tp, fp, cfg, detail))
        print(f"score {tp - fp:3d}  tp {tp:2d}  fp {fp:2d}  {cfg}  {' '.join(detail)}", flush=True)
    results.sort(key=lambda r: (-r[0], -r[1]))
    print("\nBEST")
    for r in results[:5]:
        print(r)


if __name__ == "__main__":
    main()
