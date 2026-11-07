"""The nose: ingest for a metal-oxide (MOX) VOC sensor, baseline tracking, humidity compensation,
anomaly detection and a heuristic signature classifier. Plus a simulator that feeds the *same*
ingest path the hardware uses.

Physics in one paragraph: a MOX sensor (Bosch BME688, Sensirion SGP40, Winsen MQ-135) is a heated
tin-oxide film. Reducing gases - ethanol from fermenting produce, amines/ammonia from spoiling
protein, acrolein and other aldehydes from burning or degraded fry oil - donate electrons to the
film and *lower* its resistance. So fewer ohms means more VOCs. We track a clean-air baseline and
report ``ratio = baseline / gas``: 1.0 is clean, 2.0 means the film is twice as conductive as in
clean air. The absolute ohm value is meaningless across sensors; the ratio and its time derivative
are what carry information. A single MOX channel cannot identify *which* gas it sees; the shape of
the response over time plus context (where the sensor is, what is stored there, what time it is)
is what lets us label it. That contextual step is where the LLM earns its keep.
"""
from __future__ import annotations

import math
import random
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Optional

ANOMALY_RATIO = 1.35          # sustained ratio above this is an anomaly
CLEAR_RATIO = 1.15            # ratio below this for CLEAR_SECONDS clears it
SUSTAIN_SECONDS = 4
CLEAR_SECONDS = 8
WARMUP_SAMPLES = 12           # with real hardware you'd want ~5 min; the sim warms quickly for the demo
RH_COMP_PER_PCT = 0.008       # first-order humidity correction, ~0.8 % resistance per %RH
OFFLINE_AFTER_S = 6.0


@dataclass
class Reading:
    t: float
    gas_ohm: float
    temp_c: Optional[float]
    rh: Optional[float]
    sensor_id: str
    location: str
    source: str  # "http" | "serial" | "replay"


class SmellPipeline:
    def __init__(self, on_event: Callable[[dict], None]):
        self.on_event = on_event
        self.reset()

    def reset(self) -> None:
        self.device = "none"
        self.sensor_id = "-"
        self.location = "walk-in"
        self.baseline: Optional[float] = None
        self.rh_baseline: Optional[float] = None
        self.gas: Optional[float] = None
        self.temp: Optional[float] = None
        self.rh: Optional[float] = None
        self.ratio: Optional[float] = None
        self.status = "offline"
        self.anomaly: Optional[dict] = None
        self.scenario: Optional[str] = None
        self.trace: deque[dict] = deque(maxlen=180)
        self._warm: list[float] = []
        self._ratios: deque[tuple[float, float]] = deque(maxlen=120)   # (t, ratio)
        self._temps: deque[tuple[float, float]] = deque(maxlen=120)
        self._above_since: Optional[float] = None
        self._below_since: Optional[float] = None
        self._last_rx: float = 0.0
        self._t0: Optional[float] = None
        self._peak_rate = 0.0

    # ------------------------------------------------------------------ ingest (hardware + replay)
    def ingest(self, r: Reading) -> None:
        now = time.monotonic()
        if self._t0 is None:
            self._t0 = now
        self._last_rx = now
        self.device = r.source
        if r.location != self.location and self.baseline is not None:
            self._relocate(r.location)
        self.sensor_id, self.location = r.sensor_id, r.location
        self.gas, self.temp, self.rh = r.gas_ohm, r.temp_c, r.rh
        t_rel = now - self._t0

        if self.baseline is None:
            self._warm.append(r.gas_ohm)
            self.status = "warming"
            if len(self._warm) >= WARMUP_SAMPLES:
                self.baseline = sorted(self._warm)[len(self._warm) // 2]
                self.rh_baseline = r.rh
                self.status = "nominal"
                self.on_event({"sense": "smell", "kind": "device_connected", "severity": "info",
                               "label": f"Nose online at {self.location}",
                               "detail": f"{self.sensor_id} via {r.source}; baseline {self.baseline/1000:.0f} kΩ",
                               "data": {"baseline_ohm": self.baseline, "source": r.source}})
            self.trace.append({"t": round(t_rel, 1), "ratio": 1.0})
            return

        # humidity compensation: MOX resistance falls as RH rises; correct toward baseline RH
        gas_c = r.gas_ohm
        if r.rh is not None and self.rh_baseline is not None:
            gas_c = r.gas_ohm * (1 + RH_COMP_PER_PCT * (r.rh - self.rh_baseline))
        ratio = self.baseline / max(gas_c, 1.0)
        self.ratio = ratio
        self._ratios.append((t_rel, ratio))
        if r.temp_c is not None:
            self._temps.append((t_rel, r.temp_c))
        self.trace.append({"t": round(t_rel, 1), "ratio": round(ratio, 3)})

        # slow baseline adaptation while nominal (sensor drift), never during an anomaly
        if self.status == "nominal" and ratio < 1.1:
            self.baseline = 0.995 * self.baseline + 0.005 * gas_c

        self._detect(t_rel, ratio)

    def _relocate(self, location: str) -> None:
        """Readings now come from a different place (in the demo: the scenario moved the sensor; in a
        real deployment: a different board). Keep the calibration, drop the anomaly bookkeeping so the
        new location is judged on its own signature."""
        self.status = "nominal" if self.status != "warming" else self.status
        self.anomaly = None
        self._above_since = self._below_since = None
        self._peak_rate = 0.0
        self._ratios.clear()
        self._temps.clear()
        self.on_event({"sense": "smell", "kind": "relocated", "severity": "info",
                       "label": f"Nose now watching the {location}", "detail": f"moved from {self.location}",
                       "data": {"from": self.location, "to": location}})

    def _rate(self, window_s: float) -> float:
        """d(ratio)/dt over the last ``window_s`` seconds."""
        if len(self._ratios) < 2:
            return 0.0
        t_now, r_now = self._ratios[-1]
        for t, r in reversed(self._ratios):
            if t_now - t >= window_s:
                return (r_now - r) / max(t_now - t, 1e-3)
        t, r = self._ratios[0]
        return (r_now - r) / max(t_now - t, 1e-3)

    def _temp_delta(self, window_s: float = 20) -> float:
        if len(self._temps) < 2:
            return 0.0
        t_now, c_now = self._temps[-1]
        for t, c in reversed(self._temps):
            if t_now - t >= window_s:
                return c_now - c
        return c_now - self._temps[0][1]

    def _detect(self, t: float, ratio: float) -> None:
        rate = self._rate(5.0)
        if ratio >= ANOMALY_RATIO:
            self._below_since = None
            self._above_since = self._above_since or t
            self._peak_rate = max(self._peak_rate, rate)
            if self.status != "anomaly" and t - self._above_since >= SUSTAIN_SECONDS:
                kind, conf = self._classify(ratio, self._peak_rate)
                self.status = "anomaly"
                self.anomaly = {"kind": kind, "magnitude": round(ratio, 2), "since": time.strftime("%H:%M:%S"),
                                "confidence": conf}
                self.on_event({"sense": "smell", "kind": kind, "severity": "alert" if kind == "burning" else "warn",
                               "label": self._label(kind), "detail": self._detail(kind, ratio, self._peak_rate),
                               "data": {"ratio": round(ratio, 2), "rate_per_s": round(self._peak_rate, 3),
                                        "temp_delta_c": round(self._temp_delta(), 1), "location": self.location,
                                        "confidence": conf}})
            elif self.status == "anomaly" and self.anomaly:
                self.anomaly["magnitude"] = round(max(self.anomaly["magnitude"], ratio), 2)
                # escalation: a slow signature that suddenly turns into a fast, large one is a new event
                if self.anomaly["kind"] != "burning" and rate > 0.25 and ratio > 2.5:
                    self.anomaly = {"kind": "burning", "magnitude": round(ratio, 2),
                                    "since": time.strftime("%H:%M:%S"), "confidence": 0.8}
                    self.on_event({"sense": "smell", "kind": "burning", "severity": "alert",
                                   "label": self._label("burning"), "detail": self._detail("burning", ratio, rate),
                                   "data": {"ratio": round(ratio, 2), "rate_per_s": round(rate, 3),
                                            "temp_delta_c": round(self._temp_delta(), 1),
                                            "location": self.location, "confidence": 0.8}})
        elif ratio <= CLEAR_RATIO:
            self._above_since = None
            self._below_since = self._below_since or t
            if self.status == "anomaly" and t - self._below_since >= CLEAR_SECONDS:
                self.status = "nominal"
                prev = self.anomaly["kind"] if self.anomaly else "unknown"
                self.anomaly = None
                self._peak_rate = 0.0
                self.on_event({"sense": "smell", "kind": "voc_clear", "severity": "info",
                               "label": "Air cleared", "detail": f"{prev} signature gone at {self.location}",
                               "data": {"ratio": round(ratio, 2)}})
        else:
            self._above_since = None
            self._below_since = None

    def _classify(self, ratio: float, peak_rate: float) -> tuple[str, float]:
        """Heuristic signature classifier. Honest about what it is: the shape of a single-channel
        response plus where the sensor lives. Confidence is a rough prior, not a calibrated probability."""
        temp_up = self._temp_delta() > 2.0
        if peak_rate > 0.25 and (ratio > 2.5 or temp_up):
            return "burning", 0.8
        if self.location == "fry-station":
            if peak_rate < 0.03:
                return "oil_degraded", 0.65
            return "burning", 0.6
        if peak_rate > 0.12:
            # a sharp spike in a cold room is a cleaning product or a door left open, not slow rot
            return "cleaning", 0.55
        if self.location == "walk-in" and peak_rate <= 0.12:
            return "spoilage", 0.7
        return "unknown", 0.3

    @staticmethod
    def _label(kind: str) -> str:
        return {"spoilage": "Spoilage signature", "burning": "Burning detected", "oil_degraded": "Fry oil degraded",
                "cleaning": "Cleaning-product spike", "unknown": "Unclassified VOC rise"}[kind]

    def _detail(self, kind: str, ratio: float, rate: float) -> str:
        return f"ratio {ratio:.2f}× baseline, rising {rate:.3f}/s at {self.location}"

    # ------------------------------------------------------------------ housekeeping
    def tick(self) -> None:
        if self.device != "none" and self._last_rx and time.monotonic() - self._last_rx > OFFLINE_AFTER_S:
            if self.status != "offline":
                self.on_event({"sense": "smell", "kind": "device_offline", "severity": "warn",
                               "label": "Nose offline", "detail": "no readings for 6 s", "data": {}})
            self.status = "offline"
            self.anomaly = None

    def snapshot(self) -> dict:
        return {
            "device": self.device, "sensor_id": self.sensor_id, "location": self.location,
            "baseline_ohm": None if self.baseline is None else round(self.baseline),
            "gas_ohm": None if self.gas is None else round(self.gas),
            "ratio": None if self.ratio is None else round(self.ratio, 3),
            "temp_c": None if self.temp is None else round(self.temp, 1),
            "rh": None if self.rh is None else round(self.rh, 1),
            "status": self.status, "anomaly": self.anomaly, "scenario": self.scenario,
            "trace": list(self.trace),
        }


# ---------------------------------------------------------------------- simulator
SCENARIOS = {
    # name: (location, target_ratio, rise_tau_s, decay_after_s|None, decay_tau_s, temp_delta, rh_delta)
    "spoilage_walkin": ("walk-in", 1.9, 12.0, None, 0.0, 0.0, 3.0),
    "fryer_oil":       ("fry-station", 1.55, 25.0, None, 0.0, 1.5, 0.0),
    "burning":         ("line", 3.6, 1.5, 25.0, 12.0, 6.0, 0.0),
    "cleaning":        ("walk-in", 2.3, 2.5, 10.0, 18.0, 0.0, 12.0),
    "nominal":         ("walk-in", 1.0, 10.0, None, 0.0, 0.0, 0.0),
}


class SmellSimulator:
    """Synthesises BME688-like readings at 1 Hz and pushes them through ``SmellPipeline.ingest``
    exactly as the HTTP endpoint would. Baseline ~180 kΩ with 1/f-ish drift and 0.6 % noise; stimuli
    follow first-order rise/decay, which is a fair model of a MOX film's response to a step change
    in gas concentration."""

    def __init__(self, pipeline: SmellPipeline, seed: int = 3):
        self.p = pipeline
        self.rng = random.Random(seed)
        self.running = False
        self.scenario: Optional[str] = None
        self.location = "walk-in"
        self._t = 0.0
        self._ratio = 1.0
        self._target = 1.0
        self._tau = 10.0
        self._since = 0.0
        self._drift = 0.0
        self.base_ohm = 180_000.0
        self.base_temp = 3.5   # walk-in temperature
        self.base_rh = 62.0
        self._temp_delta = 0.0
        self._rh_delta = 0.0

    def set_scenario(self, name: str) -> None:
        if name == "stop":
            self.running = False
            self.scenario = None
            self.p.scenario = None
            return
        if name not in SCENARIOS:
            raise ValueError(name)
        loc, target, tau, _, _, dtemp, drh = SCENARIOS[name]
        self.running = True
        self.scenario = name
        self.p.scenario = name
        self.location = loc
        self.base_temp = {"walk-in": 3.5, "fry-station": 31.0, "line": 27.0}[loc]
        # If the pipeline has no clean-air baseline yet, hold the stimulus back until it has one
        # (plus a couple of seconds of clean readings), otherwise the baseline would be contaminated.
        delay = 0.0 if self.p.baseline is not None else (WARMUP_SAMPLES - len(self.p._warm) + 3)
        self._target, self._tau, self._since = target, tau, self._t + delay
        self._temp_target, self._rh_target = dtemp, drh

    def step(self) -> None:
        """Call at 1 Hz."""
        if not self.running:
            return
        self._t += 1.0
        name = self.scenario or "nominal"
        _, target, tau, decay_after, decay_tau, dtemp, drh = SCENARIOS[name]
        elapsed = self._t - self._since
        if elapsed < 0:
            target, tau, dtemp, drh = 1.0, 5.0, 0.0, 0.0       # still warming up: clean air
        elif decay_after is not None and elapsed > decay_after:
            target, tau, dtemp, drh = 1.0, decay_tau, 0.0, 0.0
        # first-order approach to target
        a = 1 - math.exp(-1.0 / max(tau, 0.1))
        self._ratio += a * (target - self._ratio)
        self._temp_delta += 0.1 * (dtemp - self._temp_delta)
        self._rh_delta += 0.1 * (drh - self._rh_delta)
        # slow drift + noise
        self._drift = 0.98 * self._drift + self.rng.gauss(0, 0.002)
        noise = self.rng.gauss(0, 0.006)
        ratio = max(0.8, self._ratio * (1 + self._drift + noise))
        gas = self.base_ohm / ratio
        self.p.ingest(Reading(
            t=self._t, gas_ohm=gas, temp_c=self.base_temp + self._temp_delta + self.rng.gauss(0, 0.05),
            rh=self.base_rh + self._rh_delta + self.rng.gauss(0, 0.3),
            sensor_id="sim-bme688", location=self.location, source="replay"))
