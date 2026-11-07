"""Multi-microphone manager. Any device that opens /ws/audio becomes a mic with an id and a location
("kitchen", "front", "pass"...). A laptop and two phones make three mics. Each keeps its own
classifier state (noise floor, room noise profile, debounce) across reconnects, and all share one
prototype store, so a sound taught at the pass is recognised at the front. Room noise profiles are
persisted per location so a mic that comes back after a restart starts with the right gate.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from .classifier import EarClassifier, PrototypeStore, LABELS, PRETTY

OFFLINE_AFTER_S = 5.0


class EarManager:
    def __init__(self, data_dir: Path, on_event: Callable[[dict], None]):
        self.protos = PrototypeStore(data_dir / "ear_prototypes.json")
        self._rooms_path = data_dir / "ear_rooms.json"
        self.on_event = on_event
        self.mics: dict[str, EarClassifier] = {}          # online
        self._cache: dict[str, EarClassifier] = {}        # every classifier ever opened (keeps state)
        self._last_rx: dict[str, float] = {}
        self._sources: dict[str, str] = {}
        self._rooms: dict[str, list[float]] = self._load_rooms()

    # ------------------------------------------------------------------ room noise persistence
    def _load_rooms(self) -> dict[str, list[float]]:
        if self._rooms_path.exists():
            try:
                return json.loads(self._rooms_path.read_text())
            except Exception:
                return {}
        return {}

    def _save_rooms(self) -> None:
        try:
            self._rooms_path.write_text(json.dumps({k: [round(x, 6) for x in v] for k, v in self._rooms.items()}))
        except Exception:
            pass

    def _remember_room(self, c: EarClassifier) -> None:
        if c._noise_mag is not None:
            self._rooms[c.location] = c._noise_mag.astype(float).tolist()
            self._save_rooms()

    def _seed_room(self, c: EarClassifier) -> None:
        if c._noise_mag is None and c.location in self._rooms:
            c._noise_mag = np.array(self._rooms[c.location], dtype=np.float32)

    # ------------------------------------------------------------------ lifecycle
    def open(self, mic_id: str, location: str, source: str = "mic") -> EarClassifier:
        c = self._cache.get(mic_id)
        if c is None:
            c = EarClassifier(mic_id, location, self.protos, self.on_event)
            self._cache[mic_id] = c
        elif c.location != location:
            self._remember_room(c)
            c.location = location
            c._noise_mag = None
            c._noise_frames.clear()
        self._seed_room(c)
        self.mics[mic_id] = c
        self._sources[mic_id] = source
        self._last_rx[mic_id] = time.monotonic()
        self.on_event({"sense": "hearing", "kind": "mic_online", "label": f"Mic online: {location}",
                       "detail": f"{mic_id} ({source})", "severity": "info",
                       "data": {"mic": mic_id, "location": location, "source": source}})
        return c

    def feed(self, mic_id: str, pcm: bytes) -> None:
        c = self.mics.get(mic_id)
        if c is None:
            return
        self._last_rx[mic_id] = time.monotonic()
        c.feed_int16(pcm)

    def close(self, mic_id: str) -> None:
        c = self.mics.pop(mic_id, None)
        if c is None:
            return
        self._remember_room(c)
        self._last_rx.pop(mic_id, None)
        self._sources.pop(mic_id, None)
        self.on_event({"sense": "hearing", "kind": "mic_offline", "label": f"Mic offline: {c.location}",
                       "detail": mic_id, "severity": "info", "data": {"mic": mic_id, "location": c.location}})

    def teach(self, mic_id: Optional[str], label: str, seconds: float = 4.0) -> bool:
        if label not in LABELS:
            return False
        target = self.mics.get(mic_id) if mic_id else (next(iter(self.mics.values())) if self.mics else None)
        if target is None and self.mics:
            target = next(iter(self.mics.values()))
        if target is None:
            return False
        target.start_teach(label, seconds)
        return True

    def tick(self) -> None:
        now = time.monotonic()
        for mid in list(self.mics):
            self.mics[mid].tick()
            if now - self._last_rx.get(mid, now) > OFFLINE_AFTER_S:
                self.close(mid)

    @property
    def active(self) -> bool:
        return bool(self.mics)

    def stress_inputs(self) -> tuple[float, float]:
        if not self.mics:
            return 0.0, 0.0
        return (max(c.level_db - c.floor_db for c in self.mics.values()),
                max(c.speech_fraction for c in self.mics.values()))

    def snapshot(self) -> dict:
        return {
            "active": self.active,
            "mics": [dict(c.snapshot(), source=self._sources.get(mid, "mic")) for mid, c in self.mics.items()],
            "prototypes": self.protos.summary(),
            "labels": [{"id": l, "name": PRETTY[l]} for l in LABELS if l not in ("speech", "frying")],
            "rooms": sorted(self._rooms),
            "model": "yamnet" if any(c.model == "yamnet" for c in self.mics.values()) else
                     (next(iter(self.mics.values())).model if self.mics else "idle"),
        }
