"""Per-microphone sound-event classifier.

Pipeline per 0.5 s hop over a 0.96 s window:

1. **Level tracking and AGC.** A running noise floor (slow EMA of the quietest frames) tells us what
   "silence" is in this room. A window counts as *active* when it is 6 dB above the floor. Active
   windows are normalised to a fixed RMS before embedding, so a faint door chime across the room
   produces the same embedding as a loud one next to the mic.
2. **Room denoise (spectral gate).** Quiet frames teach a magnitude spectrum of the room; it is
   subtracted from active windows before the few-shot embedding. No model, no training, a few
   microseconds. Zero-shot scores are computed on the raw window because AudioSet was trained on
   un-gated audio.
3. **Embedding.** YAMNet gives 521 AudioSet scores and a 1024-d embedding (see ``embedder.py``).
4. **Zero-shot prior.** AudioSet classes are mapped onto kitchen events (alarm/beep → fryer alarm,
   doorbell/ding → door chime, printer → ticket printer, dishes/glass → clatter, telephone → phone).
   Works out of the box, no calibration.
5. **Few-shot calibration.** The owner *teaches* a sound: a few seconds of their actual fryer alarm,
   their actual door chime, through the actual mic. Active-window embeddings become prototypes; each
   example is also mixed with the room's own recorded noise at lower SNRs so one quiet teaching
   session covers a loud night. The room itself is memorised as a ``_background`` class. At run time
   a weighted k-nearest-neighbour vote over all prototypes decides; what you taught wins over the
   zero-shot prior.
6. **Temporal confirmation and merging.** Long sounds (alarm, printer, phone) must win two hops in a
   row before firing; consecutive matches of one kind are the same sound, not a new event; a burst
   counter lets the agent say "four tickets in 30 s" instead of four lines.

Every event carries what the classifier saw (top AudioSet classes, neighbour similarities, level),
so the UI can show *why* it fired. ``CFG`` holds the tunables so ``tests/eval_ear.py`` can sweep them.
"""
from __future__ import annotations

import json
import math
from collections import deque
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from . import embedder

SR = 16000
HOP = int(0.5 * SR)
WINDOW = embedder.WINDOW
TARGET_RMS_DB = -20.0
ACTIVITY_DB_ABOVE_FLOOR = 6.0
BACKGROUND = "_background"

CFG = {
    "gate": True,            # spectral gate before the few-shot embedding
    "gate_alpha": 1.4,
    "gate_floor": 0.1,
    "knn_k": 3,              # neighbours in the vote
    "few_thr": 0.74,         # nearest-neighbour similarity needed for a taught label
    "few_margin": 0.03,      # vote margin over background / other labels
    "confirm": {},           # consecutive hops required per kind; merging already handles duplicates
    "aug_snr_db": (15.0, 8.0),
    "teach_min_db_above_floor": 10.0,     # only learn windows clearly louder than the room
    "zs_confirm": {"fryer_alarm": 2, "phone_ring": 2},   # zero-shot needs 2 hops for long tonal sounds
    "gain_cap_skip": 40.0,                # a window needing this much gain is a transient in silence: skip
    "zero_shot": True,
}

ZERO_SHOT = {
    "fryer_alarm": {"Alarm": 1.0, "Beep, bleep": 1.0, "Buzzer": 0.8, "Smoke detector, smoke alarm": 1.0,
                    "Microwave oven": 0.5, "Alarm clock": 0.8, "Fire alarm": 1.0, "Whistle": 0.6, "Whistling": 0.5},
    "door_chime": {"Doorbell": 1.0, "Ding": 0.9, "Ding-dong": 1.0, "Chime": 0.9, "Bell": 0.6,
                   "Wind chime": 0.5, "Bicycle bell": 0.6},
    "ticket_burst": {"Printer": 1.0, "Typewriter": 0.5, "Typing": 0.3, "Tools": 0.4, "Power tool": 0.3},
    "clatter": {"Dishes, pots, and pans": 1.0, "Glass": 0.8, "Cutlery, silverware": 0.8, "Shatter": 1.0,
                "Breaking": 0.8, "Bang": 0.5, "Slam": 0.5},
    "phone_ring": {"Telephone bell ringing": 1.0, "Ringtone": 1.0, "Telephone": 0.7},
    "speech": {"Speech": 1.0, "Conversation": 1.0, "Shout": 0.8, "Yell": 0.8},
    "frying": {"Sizzle": 1.0, "Frying (food)": 1.0},
}
ZERO_SHOT_THRESHOLD = {"fryer_alarm": 0.30, "door_chime": 0.30, "ticket_burst": 0.30, "clatter": 0.40,
                       "phone_ring": 0.40, "speech": 0.45, "frying": 0.35}
HOLD_S = {"fryer_alarm": 6.0, "door_chime": 3.0, "ticket_burst": 5.0, "clatter": 4.0, "phone_ring": 6.0}
CONTINUATION_GAP_S = 1.6
LABELS = ["fryer_alarm", "door_chime", "ticket_burst", "clatter", "phone_ring", "speech", "frying"]
EVENT_LABELS = ["fryer_alarm", "door_chime", "ticket_burst", "clatter", "phone_ring"]
NOISE_CLASSES = {"White noise", "Pink noise", "Static", "Silence", "Noise", "Hum", "Mains hum", "Hiss"}
PRETTY = {"fryer_alarm": "Fryer alarm", "door_chime": "Door chime", "ticket_burst": "Ticket printer",
          "clatter": "Clatter", "phone_ring": "Phone ringing", "speech": "Voices", "frying": "Frying",
          BACKGROUND: "Room background"}


class PrototypeStore:
    """Few-shot memory shared by every microphone. Persisted as JSON so calibration survives restarts."""

    def __init__(self, path: Path):
        self.path = path
        self.protos: dict[str, list[np.ndarray]] = {}
        self.load()

    def load(self) -> None:
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text())
                self.protos = {k: [np.array(v, dtype=np.float32) for v in vs] for k, vs in raw.items()}
            except Exception:
                self.protos = {}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({k: [np.round(v, 4).tolist() for v in vs] for k, vs in self.protos.items()}))

    def add(self, label: str, emb: np.ndarray, persist: bool = True) -> None:
        self.protos.setdefault(label, []).append(emb / (np.linalg.norm(emb) + 1e-9))
        keep = 60 if label == BACKGROUND else 48
        del self.protos[label][:-keep]
        if persist:
            self.save()

    def forget(self, label: str) -> None:
        self.protos.pop(label, None)
        self.save()

    def taught_labels(self) -> list[str]:
        return [k for k, v in self.protos.items() if v and k != BACKGROUND]

    def neighbours(self, emb: np.ndarray, k: int) -> list[tuple[float, str]]:
        e = emb / (np.linalg.norm(emb) + 1e-9)
        pairs: list[tuple[float, str]] = []
        for label, vs in self.protos.items():
            if vs:
                sims = np.array(vs) @ e
                for s in np.sort(sims)[::-1][:k]:
                    pairs.append((float(s), label))
        pairs.sort(reverse=True)
        return pairs[:k]

    def similarities(self, emb: np.ndarray) -> dict[str, float]:
        e = emb / (np.linalg.norm(emb) + 1e-9)
        return {k: float(np.max(np.array(vs) @ e)) for k, vs in self.protos.items() if vs}

    def summary(self) -> list[dict]:
        return [{"label": k, "examples": len(v), "name": PRETTY.get(k, k)} for k, v in self.protos.items() if v]


class EarClassifier:
    def __init__(self, mic_id: str, location: str, protos: PrototypeStore,
                 on_event: Callable[[dict], None]):
        self.mic_id, self.location, self.protos, self.on_event = mic_id, location, protos, on_event
        self._buf = np.zeros(0, dtype=np.float32)
        self._pending = 0
        self.t = 0.0
        self.level_db = -90.0
        self.floor_db = -60.0
        self.active = False
        self._last_fire: dict[str, float] = {}
        self._last_match: dict[str, float] = {}
        self._recent_hits: deque[tuple[float, str]] = deque(maxlen=12)
        self._bursts: deque[tuple[float, str]] = deque(maxlen=50)
        self.last_scores: dict[str, float] = {}
        self.last_top: list[tuple[str, float]] = []
        self.last_sims: dict[str, float] = {}
        self.teaching: Optional[dict] = None
        self.speech_fraction = 0.0
        self.model = "yamnet" if embedder.status() == "ready" else "loading"
        self.windows_processed = 0
        self._noise_mag: Optional[np.ndarray] = None
        self._noise_frames: deque[np.ndarray] = deque(maxlen=8)

    # ------------------------------------------------------------------ ingest
    def feed_int16(self, pcm: bytes) -> None:
        x = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        self._buf = np.concatenate([self._buf, x])
        self._pending += len(x)
        if len(self._buf) > 2 * SR:
            self._buf = self._buf[-2 * SR:]
        while self._pending >= HOP and len(self._buf) >= WINDOW:
            self._pending -= HOP
            self.t += HOP / SR
            self._process(self._buf[-WINDOW:])

    # ------------------------------------------------------------------ denoise
    def _learn_noise(self, win: np.ndarray) -> None:
        mag = np.abs(np.fft.rfft(win * np.hanning(len(win))))
        self._noise_mag = mag if self._noise_mag is None else 0.9 * self._noise_mag + 0.1 * mag
        self._noise_frames.append(win.copy())

    def _gate(self, x: np.ndarray, gain: float) -> np.ndarray:
        if not CFG["gate"] or self._noise_mag is None:
            return x
        spec = np.fft.rfft(x * np.hanning(len(x)))
        mag, phase = np.abs(spec), np.angle(spec)
        clean = np.maximum(mag - CFG["gate_alpha"] * self._noise_mag * gain, CFG["gate_floor"] * mag)
        return np.fft.irfft(clean * np.exp(1j * phase), n=len(x)).astype(np.float32)

    # ------------------------------------------------------------------ core
    def _process(self, win: np.ndarray) -> None:
        rms = float(np.sqrt(np.mean(win * win)) + 1e-9)
        db = 20 * math.log10(rms)
        self.level_db = db
        if db < self.floor_db:
            self.floor_db += 0.5 * (db - self.floor_db)
        else:
            self.floor_db += 0.01 * (db - self.floor_db)
        self.floor_db = max(self.floor_db, -75.0)      # digital silence must not make everything "loud"
        self.active = db > self.floor_db + ACTIVITY_DB_ABOVE_FLOOR and db > -55
        if not self.active:
            self.speech_fraction *= 0.95
            self._learn_noise(win)
            return
        gain = min(10 ** ((TARGET_RMS_DB - db) / 20), 60.0)
        x = np.clip(win * gain, -1, 1)

        raw = embedder.embed(x)
        if raw is None:
            self.model = "dsp-fallback"
            return
        self.model = "yamnet"
        scores, _ = raw
        gated = embedder.embed(self._gate(x, gain)) if CFG["gate"] and self._noise_mag is not None else raw
        emb = gated[1]
        self.windows_processed += 1
        names = embedder.class_names()
        top = np.argsort(scores)[::-1][:5]
        self.last_top = [(names[i], float(scores[i])) for i in top]
        name_idx = {n: i for i, n in enumerate(names)}
        zs = {label: float(sum(w * scores[name_idx[n]] for n, w in members.items() if n in name_idx))
              for label, members in ZERO_SHOT.items()}
        self.last_scores = zs
        self.speech_fraction = 0.9 * self.speech_fraction + 0.1 * (1.0 if zs["speech"] > 0.4 else 0.0)

        if self.teaching:
            if self.t <= self.teaching["until"]:
                noisy = self.last_top[0][0] in NOISE_CLASSES
                if db - self.floor_db >= CFG["teach_min_db_above_floor"] and not noisy:
                    self._learn_example(x, gain, emb)
                return
            self._finish_teach()
        if gain >= CFG["gain_cap_skip"]:
            return                          # transient in near-silence; wait for a fuller window

        sims = self.protos.similarities(emb)
        self.last_sims = sims
        if self.last_top[0][0] in NOISE_CLASSES and zs.get("speech", 0) < 0.3:
            # steady noise (fan, hiss, static) is the room, never an event; remember it as background
            if self.windows_processed % 2 == 0:
                self.protos.add(BACKGROUND, emb, persist=(self.windows_processed % 50 == 0))
            return
        fired, how, conf = self._decide(emb, zs, sims)
        if fired is None:
            if self.windows_processed % 5 == 0 and zs.get("speech", 0) < 0.3:
                self.protos.add(BACKGROUND, emb, persist=(self.windows_processed % 50 == 0))
            return

        # temporal confirmation for long sounds (zero-shot decisions need more)
        need = CFG["confirm"].get(fired, 1)
        if how == "zero-shot":
            need = max(need, CFG["zs_confirm"].get(fired, 1))
        self._recent_hits.append((self.t, fired))
        hits = sum(1 for t, k in self._recent_hits if k == fired and self.t - t <= 2.0)
        if hits < need:
            return

        last_match = self._last_match.get(fired, -1e9)
        self._last_match[fired] = self.t
        if self.t - last_match <= CONTINUATION_GAP_S:
            return
        if self.t - self._last_fire.get(fired, -1e9) < HOLD_S.get(fired, 3.0):
            return
        self._last_fire[fired] = self.t
        self._bursts.append((self.t, fired))
        burst = sum(1 for t, k in self._bursts if k == fired and self.t - t <= 30)
        self.on_event({
            "sense": "hearing", "kind": fired, "label": PRETTY.get(fired, fired),
            "detail": f"{how} · {conf:.2f} · {self.last_top[0][0]} · {db:.0f} dBFS at {self.location}",
            "severity": "warn" if fired in ("fryer_alarm", "phone_ring") else "info",
            "data": {"mic": self.mic_id, "location": self.location, "how": how, "confidence": round(conf, 3),
                     "db": round(db, 1), "floor_db": round(self.floor_db, 1), "burst_30s": burst,
                     "top": [[n, round(s, 3)] for n, s in self.last_top[:3]],
                     "zero_shot": {k: round(v, 3) for k, v in zs.items()},
                     "taught": {k: round(v, 3) for k, v in sims.items()}},
        })

    def _decide(self, emb: np.ndarray, zs: dict, sims: dict) -> tuple[Optional[str], str, float]:
        taught = self.protos.taught_labels()
        if taught:
            nb = self.protos.neighbours(emb, CFG["knn_k"])
            votes: dict[str, float] = {}
            for s, label in nb:
                votes[label] = votes.get(label, 0.0) + s
            winner = max(votes, key=votes.get)
            runner = max([v for k, v in votes.items() if k != winner], default=0.0)
            top_sim = max((s for s, l in nb if l == winner), default=0.0)
            if winner != BACKGROUND and top_sim >= CFG["few_thr"] and votes[winner] - runner >= CFG["few_margin"]:
                return winner, "taught", top_sim
            if winner == BACKGROUND and top_sim >= CFG["few_thr"]:
                return None, "", 0.0            # confidently just the room
            if winner in taught and top_sim >= CFG["few_thr"] - 0.08:
                return None, "", 0.0            # near a taught sound but ambiguous: stay quiet rather than guess
        if CFG["zero_shot"]:
            best = max(zs, key=zs.get)
            dominant = self.last_top[0][0]
            if (best in EVENT_LABELS and zs[best] >= ZERO_SHOT_THRESHOLD[best]
                    and dominant in ZERO_SHOT.get(best, {})):
                return best, "zero-shot", min(1.0, zs[best] / 0.6)
        return None, "", 0.0

    # ------------------------------------------------------------------ teaching
    def _learn_example(self, x: np.ndarray, gain: float, emb: np.ndarray) -> None:
        label = self.teaching["label"]
        self.protos.add(label, emb, persist=False)
        self.teaching["count"] += 1
        if self._noise_frames:
            noise = self._noise_frames[self.teaching["count"] % len(self._noise_frames)]
            n_rms = float(np.sqrt(np.mean(noise ** 2)) + 1e-9)
            x_rms = float(np.sqrt(np.mean(x ** 2)) + 1e-9)
            for snr in CFG["aug_snr_db"]:
                want = x_rms / (10 ** (snr / 20))
                mixed = np.clip(x + noise * (want / n_rms), -1, 1)
                aug = embedder.embed(self._gate(mixed, gain))
                if aug is not None:
                    self.protos.add(label, aug[1], persist=False)

    def start_teach(self, label: str, seconds: float = 4.0) -> None:
        self.teaching = {"label": label, "until": self.t + seconds, "count": 0, "seconds": seconds}

    def _finish_teach(self) -> None:
        t, self.teaching = self.teaching, None
        if t is None:
            return
        self.protos.save()
        self.on_event({"sense": "hearing", "kind": "taught", "label": f"Learned {PRETTY.get(t['label'], t['label'])}",
                       "detail": f"{t['count']} examples from the {self.location} mic", "severity": "info",
                       "data": {"mic": self.mic_id, "label": t["label"], "examples": t["count"]}})

    def tick(self) -> None:
        if self.teaching and self.t > self.teaching["until"] + 1.0:
            self._finish_teach()

    def snapshot(self) -> dict:
        return {
            "mic": self.mic_id, "location": self.location, "model": self.model,
            "level_db": round(self.level_db, 1), "floor_db": round(self.floor_db, 1), "active": self.active,
            "speech_fraction": round(self.speech_fraction, 2),
            "scores": {k: round(v, 3) for k, v in self.last_scores.items()},
            "top": [[n, round(s, 3)] for n, s in self.last_top[:3]],
            "taught": {k: round(v, 3) for k, v in self.last_sims.items()},
            "teaching": None if not self.teaching else {
                "label": self.teaching["label"], "remaining_s": round(max(0.0, self.teaching["until"] - self.t), 1),
                "examples": self.teaching["count"]},
            "windows": self.windows_processed,
        }
