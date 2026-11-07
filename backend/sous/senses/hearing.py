"""The ears: a small DSP classifier for kitchen sound events over 16 kHz mono PCM.

We deliberately do *not* run speech recognition or a big audio model here. A kitchen's
machine sounds are stereotyped, and three of them carry most of the operational signal:

* ticket printer  - broadband, buzzy, amplitude-modulated bursts (thermal head stepping), 0.6-3 s
* fryer alarm     - a loud, stable pure tone between 2 and 4.5 kHz, beeping or continuous
* door chime      - a tonal onset in 0.7-2.5 kHz that decays within ~1 s

Each ~250 ms chunk is split into 25 ms frames. Per frame we compute RMS (dBFS), the FFT peak
frequency, peak prominence over the median spectrum, and spectral flatness. Rules over a
3-second history turn those into events with debouncing. Features are attached to each event
so the Senses page can show the judges what the classifier saw.

In production this would be a small learned model (e.g. YAMNet-style embeddings + a linear
head trained on this kitchen); the rule set is the honest six-hour version and it is tuned on
the synthesized demo soundtrack in ``demo_audio.py``.
"""
from __future__ import annotations

import time
from collections import deque
from typing import Callable, Optional

import numpy as np

SR = 16000
FRAME = 400          # 25 ms
HISTORY_S = 3.0


class HearingClassifier:
    def __init__(self, on_event: Callable[[dict], None]):
        self.on_event = on_event
        self.reset()

    def reset(self) -> None:
        self.active = False
        self.source = "none"
        self.noise_db = -60.0
        self.stress = 0.0
        self._frames: deque[dict] = deque(maxlen=int(HISTORY_S * SR / FRAME))
        self._pending = np.zeros(0, dtype=np.float32)
        self._last_fire: dict[str, float] = {}
        self._ticket_times: deque[float] = deque(maxlen=20)
        self._t = 0.0

    def set_source(self, source: str) -> None:
        self.source = source
        self.active = source != "none"
        if not self.active:
            self.noise_db = -60.0

    # ------------------------------------------------------------------ features
    @staticmethod
    def _features(x: np.ndarray) -> dict:
        rms = float(np.sqrt(np.mean(x * x)) + 1e-9)
        db = 20 * np.log10(rms)
        win = x * np.hanning(len(x))
        spec = np.abs(np.fft.rfft(win)) + 1e-9
        freqs = np.fft.rfftfreq(len(x), 1 / SR)
        band = (freqs > 150) & (freqs < 7000)
        s, f = spec[band], freqs[band]
        k = int(np.argmax(s))
        peak_hz = float(f[k])
        prominence_db = float(20 * np.log10(s[k] / np.median(s)))
        flatness = float(np.exp(np.mean(np.log(s))) / np.mean(s))
        return {"db": float(db), "peak_hz": peak_hz, "prom_db": prominence_db, "flatness": flatness}

    # ------------------------------------------------------------------ ingest
    def feed_int16(self, pcm: bytes) -> None:
        x = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        self._pending = np.concatenate([self._pending, x])
        while len(self._pending) >= FRAME:
            frame, self._pending = self._pending[:FRAME], self._pending[FRAME:]
            self._t += FRAME / SR
            f = self._features(frame)
            f["t"] = self._t
            self._frames.append(f)
            self._update_noise(f["db"])
        self._rules()

    def _update_noise(self, db: float) -> None:
        self.noise_db = 0.9 * self.noise_db + 0.1 * max(db, -60.0)
        self._recompute_stress()

    def set_load(self, open_tickets: int) -> None:
        """Order load from the sim/POS, fused with what the ears hear."""
        self._load = open_tickets
        self._recompute_stress()

    def _recompute_stress(self) -> None:
        tickets_recent = sum(1 for t in self._ticket_times if self._t - t < 30)
        audio = 0.6 * (self.noise_db + 45) / 30 + 0.4 * tickets_recent / 6 if self.active else 0.0
        load = getattr(self, "_load", 0) / 12.0
        self.stress = float(np.clip(max(audio, load), 0, 1))

    # ------------------------------------------------------------------ rules
    def _debounced(self, kind: str, hold_s: float) -> bool:
        last = self._last_fire.get(kind, -1e9)
        if self._t - last < hold_s:
            return False
        self._last_fire[kind] = self._t
        return True

    def _emit(self, kind: str, label: str, detail: str, severity: str, **data) -> None:
        self.on_event({"sense": "hearing", "kind": kind, "label": label, "detail": detail,
                       "severity": severity, "data": {k: (round(v, 3) if isinstance(v, float) else v)
                                                      for k, v in data.items()}})

    def _rules(self) -> None:
        n = len(self._frames)
        if n < 24:
            return
        fr = list(self._frames)
        recent = fr[-24:]                      # last 600 ms
        prev = fr[-44:-24] if n >= 44 else fr[:-24]
        dbs = np.array([f["db"] for f in recent])
        peaks = np.array([f["peak_hz"] for f in recent])
        proms = np.array([f["prom_db"] for f in recent])
        flats = np.array([f["flatness"] for f in recent])
        loud = dbs > -42

        # fryer alarm: stable, loud, tonal peak in 2-4.5 kHz for >= 500 ms
        tonal = (proms > 14) & (flats < 0.25) & loud
        in_band = (peaks > 1900) & (peaks < 4600)
        mask = tonal & in_band
        if mask.sum() >= 20:
            med = np.median(peaks[mask])
            if np.all(np.abs(peaks[mask] - med) / med < 0.04):
                if self._debounced("fryer_alarm", 3.0):
                    self._emit("fryer_alarm", "Fryer alarm", f"{med:.0f} Hz tone, {dbs.max():.0f} dBFS",
                               "warn", peak_hz=float(med), prom_db=float(proms[mask].mean()),
                               flatness=float(flats[mask].mean()), db=float(dbs.max()))
                return

        # door chime: tonal onset 700-2500 Hz, > 10 dB above the preceding half second, decaying
        if prev:
            prev_db = float(np.median([f["db"] for f in prev]))
            onset_idx = int(np.argmax(dbs))
            if (dbs[onset_idx] - prev_db > 10 and proms[onset_idx] > 12 and flats[onset_idx] < 0.3
                    and 650 < peaks[onset_idx] < 2600 and onset_idx <= 12
                    and dbs[-1] < dbs[onset_idx] - 6):
                if self._debounced("door_chime", 2.5):
                    self._emit("door_chime", "Door chime", f"{peaks[onset_idx]:.0f} Hz ding, decayed "
                               f"{dbs[onset_idx]-dbs[-1]:.0f} dB in 0.5 s", "info",
                               peak_hz=float(peaks[onset_idx]), prom_db=float(proms[onset_idx]),
                               flatness=float(flats[onset_idx]), db=float(dbs[onset_idx]))
                    return

        # ticket printer: broadband, loud-ish, amplitude modulated (many onsets per second)
        broadband = (flats > 0.38) & (dbs > -40)
        if broadband.sum() >= 14:
            d = np.diff(dbs)
            onsets = int(np.sum(d > 4))
            if onsets >= 5:
                if self._debounced("ticket_burst", 2.0):
                    self._ticket_times.append(self._t)
                    self._emit("ticket_burst", "Ticket printer", f"buzzy burst, {onsets} onsets/600 ms, "
                               f"flatness {flats[broadband].mean():.2f}", "info",
                               flatness=float(flats[broadband].mean()), onsets=onsets, db=float(dbs.max()))
                    return

        # loud clatter / shouting: broadband and very loud for most of the window
        if np.mean(dbs > -30) > 0.6 and np.mean(flats > 0.3) > 0.5 and dbs.max() > -16:
            if self._debounced("noise_spike", 4.0):
                self._emit("noise_spike", "Loud clatter", f"{dbs.mean():.0f} dBFS sustained", "info",
                           db=float(dbs.mean()), flatness=float(flats.mean()))

    def snapshot(self) -> dict:
        return {"active": self.active, "source": self.source, "noise_db": round(self.noise_db, 1),
                "stress": round(self.stress, 2)}
