"""Multi-microphone manager. Any device that opens /ws/audio becomes a mic with an id and a location
("kitchen", "front", "pass"...). A laptop and two phones make three mics. Each has its own
classifier state (noise floor, debounce) but they share one prototype store, so a sound taught at
the pass is recognised at the front.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Callable, Optional

from .classifier import EarClassifier, PrototypeStore, LABELS, PRETTY

OFFLINE_AFTER_S = 5.0


class EarManager:
    def __init__(self, data_dir: Path, on_event: Callable[[dict], None]):
        self.protos = PrototypeStore(data_dir / "ear_prototypes.json")
        self.on_event = on_event
        self.mics: dict[str, EarClassifier] = {}
        self._last_rx: dict[str, float] = {}
        self._sources: dict[str, str] = {}

    def open(self, mic_id: str, location: str, source: str = "mic") -> EarClassifier:
        c = self.mics.get(mic_id)
        if c is None or c.location != location:
            c = EarClassifier(mic_id, location, self.protos, self.on_event)
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
        if mic_id in self.mics:
            loc = self.mics[mic_id].location
            del self.mics[mic_id]
            self._last_rx.pop(mic_id, None)
            self._sources.pop(mic_id, None)
            self.on_event({"sense": "hearing", "kind": "mic_offline", "label": f"Mic offline: {loc}",
                           "detail": mic_id, "severity": "info", "data": {"mic": mic_id, "location": loc}})

    def teach(self, mic_id: Optional[str], label: str, seconds: float = 4.0) -> bool:
        if label not in LABELS:
            return False
        target = self.mics.get(mic_id) if mic_id else (next(iter(self.mics.values())) if self.mics else None)
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
        """(loudest level above floor in dB, max speech fraction) across mics."""
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
            "model": "yamnet" if any(c.model == "yamnet" for c in self.mics.values()) else
                     (next(iter(self.mics.values())).model if self.mics else "idle"),
        }
