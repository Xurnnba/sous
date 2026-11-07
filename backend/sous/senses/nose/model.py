"""Gradient-boosted fingerprint classifier for the nose.

A ``HistGradientBoostingClassifier`` over the 22 features in ``features.py``, trained on ~6000
synthetic windows from ``physics.generate_windows`` with class balancing. It is deliberately small
and fast (sub-millisecond inference, <60 s training on a laptop CPU) and lives at
``backend/data/nose_model.joblib`` together with its metadata (feature names, classes, held-out
accuracy, confusion matrix, training-set size).

HONESTY NOTE. The training data is synthetic. The held-out accuracy printed at train time measures
how well the model learned the *simulator*, not how well it will do on a real cooler. The model
file is a bootstrap so the pipeline and agent can be exercised end to end; the plan is to log
labelled episodes from real boards and retrain with ``NoseModel.train(X, y)`` on those.

``predict`` returns ``unknown`` when the top probability is below ``UNKNOWN_BELOW`` or the margin to
the runner-up is small - unless both leaders are the same family (``spoilage_*``), in which case the
family is confidently detected even if the species is not, and the leading species is reported with
the family's summed confidence.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

import joblib
import numpy as np

from .features import FEATURE_NAMES, N_FEATURES
from .physics import CLASSES

MODEL_NAME = "gbdt-fingerprint"
DEFAULT_PATH = Path(__file__).resolve().parents[3] / "data" / "nose_model.joblib"
UNKNOWN_BELOW = 0.55
MIN_MARGIN = 0.15
FAMILIES = {"spoilage_produce": "spoilage", "spoilage_protein": "spoilage"}


class NoseModel:
    def __init__(self, path: Path | str = DEFAULT_PATH):
        self.path = Path(path)
        self.clf = None
        self.classes: list[str] = list(CLASSES)
        self.trained_on = 0
        self.accuracy = 0.0
        self.confusion: list[list[int]] = []
        self.feature_names = list(FEATURE_NAMES)
        self.trained_at: Optional[str] = None
        self.accuracy_by_mode: dict = {}

    # ------------------------------------------------------------------ persistence
    def load_or_train(self, n_windows: int = 8000, seed: int = 0, force: bool = False, verbose: bool = True) -> "NoseModel":
        if not force and self.path.exists():
            try:
                self._load()
                if self.feature_names == list(FEATURE_NAMES):
                    return self
                if verbose:
                    print(f"[nose] model at {self.path} has a different feature set; retraining")
            except Exception as e:  # corrupt / incompatible pickle: retrain rather than crash
                if verbose:
                    print(f"[nose] could not load {self.path}: {e!r}; retraining")
        X, y = self.synthesize(n_windows, seed, verbose=verbose)
        self.train(X, y, seed=seed, verbose=verbose)
        self.save()
        return self

    def _load(self) -> None:
        blob = joblib.load(self.path)
        self.clf = blob["clf"]
        self.classes = list(blob["classes"])
        self.trained_on = int(blob["trained_on"])
        self.accuracy = float(blob["accuracy"])
        self.confusion = blob["confusion"]
        self.feature_names = list(blob["feature_names"])
        self.trained_at = blob.get("trained_at")
        self.accuracy_by_mode = blob.get("accuracy_by_mode", {})

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump({"clf": self.clf, "classes": self.classes, "trained_on": self.trained_on,
                     "accuracy": self.accuracy, "confusion": self.confusion,
                     "feature_names": self.feature_names, "trained_at": self.trained_at,
                     "accuracy_by_mode": self.accuracy_by_mode, "name": MODEL_NAME}, self.path)

    # ------------------------------------------------------------------ training
    @staticmethod
    def synthesize(n_windows: int, seed: int, verbose: bool = True):
        import random
        from .physics import generate_windows
        t0 = time.time()
        X, y = generate_windows(n_windows, random.Random(seed))
        if verbose:
            counts = {c: int((y == c).sum()) for c in CLASSES}
            print(f"[nose] synthesized {len(y)} windows in {time.time() - t0:.1f}s: {counts}")
        return X, y

    def train(self, X: np.ndarray, y: np.ndarray, seed: int = 0, holdout: float = 0.2, verbose: bool = True) -> dict:
        from sklearn.ensemble import HistGradientBoostingClassifier
        from sklearn.metrics import accuracy_score, confusion_matrix
        from sklearn.model_selection import train_test_split

        t0 = time.time()
        self.classes = [c for c in CLASSES if c in set(y)]
        Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=holdout, random_state=seed, stratify=y)
        w = _balanced_weights(ytr)
        self.clf = HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.06, max_leaf_nodes=15, min_samples_leaf=15,
            l2_regularization=0.5, early_stopping=True, validation_fraction=0.15,
            n_iter_no_change=25, random_state=seed)
        self.clf.fit(Xtr, ytr, sample_weight=w)
        pred = self.clf.predict(Xte)
        self.accuracy = float(accuracy_score(yte, pred))
        sc = Xte[:, FEATURE_NAMES.index("single_channel")] > 0.5
        self.accuracy_by_mode = {"four_step": float(accuracy_score(yte[~sc], pred[~sc])) if (~sc).any() else None,
                                 "single_channel": float(accuracy_score(yte[sc], pred[sc])) if sc.any() else None}
        self.confusion = confusion_matrix(yte, pred, labels=self.classes).tolist()
        self.trained_on = int(len(ytr))
        self.feature_names = list(FEATURE_NAMES)
        self.trained_at = time.strftime("%Y-%m-%dT%H:%M:%S")
        if verbose:
            print(f"[nose] trained {MODEL_NAME} on {self.trained_on} windows in {time.time() - t0:.1f}s "
                  f"({self.clf.n_iter_} boosting rounds); held-out accuracy {self.accuracy:.3f} "
                  f"(4-step {self.accuracy_by_mode['four_step']:.3f}, single-channel {self.accuracy_by_mode['single_channel']:.3f})")
            print(format_confusion(self.confusion, self.classes))
        return {"accuracy": self.accuracy, "confusion": self.confusion, "classes": self.classes}

    # ------------------------------------------------------------------ inference
    def predict(self, features: np.ndarray) -> dict:
        if self.clf is None:
            raise RuntimeError("NoseModel not loaded; call load_or_train() first")
        p = self.clf.predict_proba(np.asarray(features, dtype=float).reshape(1, -1))[0]
        order = [str(c) for c in self.clf.classes_]
        probs = {c: float(p[i]) for i, c in enumerate(order)}
        top = max(probs, key=probs.get)
        fam = FAMILIES.get(top, top)
        in_family = {c for c in probs if FAMILIES.get(c, c) == fam}
        confidence = sum(probs[c] for c in in_family)           # family-level confidence
        runner_up = max((v for c, v in probs.items() if c not in in_family), default=0.0)
        label = top
        if confidence < UNKNOWN_BELOW or confidence - runner_up < MIN_MARGIN:
            label = "unknown"
        return {"label": label, "confidence": round(float(confidence), 4),
                "probs": {k: round(v, 4) for k, v in probs.items()}}

    def info(self) -> dict:
        return {"name": MODEL_NAME, "features": N_FEATURES, "trained_on": self.trained_on,
                "accuracy": round(self.accuracy, 4), "accuracy_by_mode": self.accuracy_by_mode, "classes": self.classes, "trained_at": self.trained_at,
                "synthetic": True}


def _balanced_weights(y: np.ndarray) -> np.ndarray:
    classes, counts = np.unique(y, return_counts=True)
    w = {c: len(y) / (len(classes) * n) for c, n in zip(classes, counts)}
    return np.array([w[v] for v in y], dtype=float)


def format_confusion(cm: list[list[int]], classes: list[str]) -> str:
    width = max(len(c) for c in classes) + 2
    head = " " * width + "".join(f"{c[:9]:>10}" for c in classes)
    rows = [f"{c:<{width}}" + "".join(f"{v:>10}" for v in row) for c, row in zip(classes, cm)]
    return "rows = true, cols = predicted\n" + "\n".join([head] + rows)
