"""Audio embedding model for the ears.

We use YAMNet (Google, AudioSet-trained, 3.7 M parameters, MobileNet-v1 backbone). It is small
enough for a phone or a Raspberry Pi, runs in ~7 ms per second of audio on a laptop CPU, and gives
two things per 0.96 s window: 521 AudioSet class scores (zero-shot priors such as "Alarm",
"Doorbell", "Printer", "Dishes, pots, and pans") and a 1024-d embedding we use for few-shot
calibration to *this* kitchen's sounds.

Loading is lazy and failure-tolerant: if TensorFlow is unavailable the ears fall back to the DSP
rule classifier in ``hearing.py``.
"""
from __future__ import annotations

import csv
import os
import threading
from typing import Optional

import numpy as np

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

SR = 16000
WINDOW = int(0.96 * SR)   # one YAMNet patch
_lock = threading.Lock()
_model = None
_class_names: list[str] = []
_status = "unloaded"      # unloaded | loading | ready | unavailable


def status() -> str:
    return _status


def class_names() -> list[str]:
    return _class_names


def load() -> bool:
    """Load YAMNet once. Returns True when ready."""
    global _model, _class_names, _status
    with _lock:
        if _status == "ready":
            return True
        if _status == "unavailable":
            return False
        _status = "loading"
        try:
            import warnings
            warnings.filterwarnings("ignore")
            import tensorflow_hub as hub  # type: ignore
            model = hub.load(os.environ.get("SOUS_YAMNET", "https://tfhub.dev/google/yamnet/1"))
            path = model.class_map_path().numpy().decode()
            with open(path) as f:
                names = [r["display_name"] for r in csv.DictReader(f)]
            # warm up so the first real window is fast
            model(np.zeros(WINDOW, dtype=np.float32))
            _model, _class_names, _status = model, names, "ready"
            return True
        except Exception as e:  # pragma: no cover
            _status = "unavailable"
            _err = str(e)
            return False


def embed(wave: np.ndarray) -> Optional[tuple[np.ndarray, np.ndarray]]:
    """wave: float32 mono 16 kHz, any length >= 0.96 s. Returns (class_scores[521], embedding[1024]),
    each averaged over the patches in the window, or None if the model is unavailable."""
    if _status != "ready" and not load():
        return None
    x = wave.astype(np.float32)
    if len(x) < WINDOW:
        x = np.pad(x, (0, WINDOW - len(x)))
    scores, emb, _ = _model(x)
    return scores.numpy().mean(axis=0), emb.numpy().mean(axis=0)
