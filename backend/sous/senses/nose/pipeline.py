"""NosePipeline: the ingest -> calibrate -> featurise -> classify -> event path the API talks to.

Replaces ``senses/smell.py``'s single-channel ``SmellPipeline`` with the same public surface
(``ingest``, ``tick``, ``reset``, ``snapshot``, ``on_event`` callbacks) but a four-step heater-sweep
fingerprint underneath. It accepts both the new ``gas_ohm_steps`` (4 values) and the legacy single
``gas_ohm``; the legacy value is replicated to all four steps and ``single_channel`` is flagged so the
fingerprint features are neutral and the classifier falls back on kinetics.

Hysteresis: an anomaly is declared only after the classifier has named the same non-nominal class
for ``SUSTAIN_SAMPLES`` consecutive readings while the fingerprint deviation is above a floor; it is
cleared only after ``CLEAR_SAMPLES`` consecutive nominal/quiet readings. A persistent, large
deviation the model cannot name becomes an ``unknown`` event after a longer sustain. A slow anomaly
that the model re-reads as burning with high confidence is re-emitted as burning (escalation).
A falling-edge guard keeps a decaying signal (deviation down >15 % over 6 s) from starting a new
anomaly. Baseline adaptation happens only while the pipeline itself is nominal.

Relocation (a reading arrives with a new ``location``): the calibrator re-baselines on the new
room (``Calibrator.rebase``: at least ``REBASE_SAMPLES`` readings, longer if the signal has not
settled), and the window, the hysteresis counters and the falling-edge history are all dropped so
the old room's signal cannot leak into the new room's judgement.

Events: ``{sense:"smell", kind, label, detail, severity, data}`` where kind is the class label on a
new anomaly, ``voc_clear`` when the air returns to nominal, ``device_connected``, ``device_offline``,
``relocated``. Anomaly ``data`` carries probs, confidence, fingerprint (the 4 ratios), urgency,
location, single_channel.

The classifier was bootstrapped on synthetic data (see ``physics.py``); thresholds here were tuned
against that simulator and need revisiting with real sensor logs.
"""
from __future__ import annotations

import time
from collections import deque
from typing import Callable, Optional

from .calibration import Calibrator
from .features import WINDOW_S, deviation, extract
from .model import NoseModel

WARMUP_SAMPLES = 12          # ~300 with real hardware (5 min heater settle); 12 so the demo is online in seconds
MIN_WINDOW_SAMPLES = 8       # status "calibrating" until the window has this many ratios
SUSTAIN_SAMPLES = 3          # consecutive same-class predictions before an anomaly is declared
UNKNOWN_SUSTAIN_SAMPLES = 8  # consecutive large-but-unnamed deviations before "unknown" is declared
CLEAR_SAMPLES = 8            # consecutive nominal readings before an anomaly clears
MIN_DEVIATION = 0.12         # |log ratio| floor (~12 %) for any anomaly, keeps noise from ever firing
UNKNOWN_DEVIATION = 0.26     # (~30 %) floor for an "unknown" event
ESCALATE_CONFIDENCE = 0.7
ADAPT_BELOW_DEVIATION = 0.06
OFFLINE_AFTER_S = 6.0
REBASE_SAMPLES = 6           # quick re-baseline after a relocation (sensor is known-good; only the room changed);
                             # the calibrator waits longer if the signal is still settling

URGENCY = {"burning": "now", "oil_degraded": "next", "unknown": "next", "spoilage_produce": "today",
           "spoilage_protein": "today", "cleaning": "info", "door_open": "info"}
SEVERITY = {"burning": "alert", "cleaning": "info"}
LABELS = {"spoilage_produce": "Produce turning", "spoilage_protein": "Protein spoiling",
          "burning": "Burning detected", "oil_degraded": "Fry oil degraded",
          "cleaning": "Cleaning-product spike", "unknown": "Unclassified VOC change"}


class NosePipeline:
    def __init__(self, on_event: Callable[[dict], None], model: Optional[NoseModel] = None,
                 warmup_samples: int = WARMUP_SAMPLES):
        self.on_event = on_event
        self.model = model
        self.warmup_samples = warmup_samples
        self.rebase_samples = REBASE_SAMPLES
        self.reset()

    # ------------------------------------------------------------------ lifecycle
    def reset(self) -> None:
        self.device = "none"
        self.sensor_id = "-"
        self.location = "walk-in"
        self.status = "offline"
        self.scenario: Optional[str] = None
        self.calibrator = Calibrator(warmup_samples=self.warmup_samples)
        self.single_channel = False
        self.ratios: Optional[list[float]] = None
        self.fingerprint: Optional[list[float]] = None
        self.probs: Optional[dict] = None
        self.prediction: Optional[dict] = None
        self.anomaly: Optional[dict] = None
        self.temp: Optional[float] = None
        self.rh: Optional[float] = None
        self.gas_steps: Optional[list[float]] = None
        self.trace: deque = deque(maxlen=180)
        self._window: deque = deque()
        self._t0: Optional[float] = None
        self._last_t: Optional[float] = None
        self._last_rx = 0.0
        self._streak_label: Optional[str] = None
        self._streak = 0
        self._quiet_streak = 0
        self._unknown_streak = 0
        self._devs: deque = deque(maxlen=60)    # (t, deviation) history for the falling-edge guard
        self._announced = False

    def _ensure_model(self) -> NoseModel:
        if self.model is None:
            self.model = NoseModel().load_or_train(verbose=False)
        return self.model

    # ------------------------------------------------------------------ ingest
    def ingest(self, r: dict) -> None:
        """``r``: ``{t?, gas_ohm_steps?:[4], gas_ohm?, temp_c?, rh?, sensor_id?, location?, source?}``."""
        now = time.monotonic()
        self._last_rx = now
        steps, single = _steps_from(r)
        if steps is None:
            return
        self.single_channel = single
        self.device = r.get("source") or "http"
        loc = r.get("location") or self.location
        if loc != self.location and self.calibrator.status == "ready":
            self._relocate(loc)
        self.location = loc
        self.sensor_id = r.get("sensor_id") or self.sensor_id
        self.temp = _f(r.get("temp_c"))
        self.rh = _f(r.get("rh"))
        self.gas_steps = steps
        t = self._timebase(r.get("t"), now)

        ratios = self.calibrator.compensate(steps, self.rh)
        if ratios is None:
            self.status = "warming"
            self.trace.append({"t": round(t, 1), "ratio": 1.0, "ratios": [1.0] * 4})
            return
        if not self._announced:
            self._announced = True
            self.status = "calibrating"
            cal = self.calibrator.snapshot()
            self.on_event({"sense": "smell", "kind": "device_connected", "severity": "info",
                           "label": f"Nose online at {self.location}",
                           "detail": f"{self.sensor_id} via {self.device}; baseline {cal['baseline_ohm_step2']/1000:.0f} kΩ at step 2"
                                     + ("; single channel" if single else "; 4-step heater sweep"),
                           "data": {"baseline_ohm": cal["baseline_ohm"], "source": self.device,
                                    "single_channel": single}})

        self.ratios = ratios
        self._window.append({"t": t, "ratios": ratios, "temp_c": self.temp, "rh": self.rh})
        while self._window and self._window[0]["t"] < t - WINDOW_S:
            self._window.popleft()
        self.trace.append({"t": round(t, 1), "ratio": round(ratios[2], 3), "ratios": [round(x, 3) for x in ratios]})

        if len(self._window) < MIN_WINDOW_SAMPLES:
            self.status = "calibrating"
            self.calibrator.adapt(steps, self.rh, nominal=deviation(ratios) < ADAPT_BELOW_DEVIATION)
            return

        feats = extract(list(self._window), single_channel=single)
        pred = self._ensure_model().predict(feats)
        self.prediction = pred
        self.probs = pred["probs"]
        self.fingerprint = _shape(feats)
        dev = deviation(ratios)
        self._detect(t, pred, dev)
        if self.status == "nominal":
            self.calibrator.adapt(steps, self.rh, nominal=(pred["label"] == "nominal" and dev < ADAPT_BELOW_DEVIATION))

    def _timebase(self, t_in, now: float) -> float:
        """Prefer the board's own clock (seconds), fall back to monotonic. Both become seconds since
        the first reading; a backwards jump (board rebooted) restarts the base."""
        t_raw = _f(t_in)
        if t_raw is None:
            t_raw = now
        if self._t0 is None or (self._last_t is not None and t_raw < self._last_t - 5.0):
            self._t0 = t_raw
        self._last_t = t_raw
        return t_raw - self._t0

    # ------------------------------------------------------------------ detection with hysteresis
    def _detect(self, t: float, pred: dict, dev: float) -> None:
        label = pred["label"]
        # falling-edge guard: a decaying tail (after a cleaning spike or a cleared anomaly) is never a
        # *new* finding, whatever the classifier thinks of its shape
        devs = self._devs
        devs.append((t, dev))
        past = [d for (tt, d) in devs if t - tt >= 6.0]
        falling = bool(past) and dev < 0.85 * past[-1]
        named = label not in ("nominal", "unknown") and dev >= MIN_DEVIATION and not falling
        if named:
            self._streak = self._streak + 1 if label == self._streak_label else 1
            self._streak_label = label
        else:
            self._streak, self._streak_label = 0, None
        self._unknown_streak = self._unknown_streak + 1 if (label == "unknown" and dev >= UNKNOWN_DEVIATION) else 0
        quiet = label == "nominal" or dev < MIN_DEVIATION
        self._quiet_streak = self._quiet_streak + 1 if quiet else 0

        if self.status != "anomaly":
            self.status = "nominal"
            if named and self._streak >= SUSTAIN_SAMPLES:
                self._raise(label, pred, dev)
            elif self._unknown_streak >= UNKNOWN_SUSTAIN_SAMPLES:
                self._raise("unknown", pred, dev)
            return

        # in anomaly: update, maybe escalate, maybe clear
        self.anomaly["confidence"] = pred["confidence"] if label == self.anomaly["kind"] else self.anomaly["confidence"]
        self.anomaly["peak_deviation"] = round(max(self.anomaly.get("peak_deviation", 0.0), dev), 3)
        if (label == "burning" and self.anomaly["kind"] != "burning" and self._streak >= SUSTAIN_SAMPLES
                and pred["confidence"] >= ESCALATE_CONFIDENCE):
            self._raise("burning", pred, dev, escalated_from=self.anomaly["kind"])
        elif self._quiet_streak >= CLEAR_SAMPLES:
            prev = self.anomaly["kind"]
            self.anomaly = None
            self.status = "nominal"
            self.on_event({"sense": "smell", "kind": "voc_clear", "severity": "info", "label": "Air cleared",
                           "detail": f"{prev} signature gone at {self.location}",
                           "data": {"previous": prev, "reason": "cleared",
                                    "fingerprint": [round(x, 3) for x in self.ratios or []],
                                    "location": self.location}})

    def _raise(self, kind: str, pred: dict, dev: float, escalated_from: Optional[str] = None) -> None:
        urgency = URGENCY.get(kind, "next")
        self.status = "anomaly"
        self.anomaly = {"kind": kind, "confidence": pred["confidence"], "urgency": urgency,
                        "since": time.strftime("%H:%M:%S"), "peak_deviation": round(dev, 3)}
        detail = (f"fingerprint {_fmt(self.ratios)} ({dev*100:.0f} % off baseline) at {self.location}, "
                  f"confidence {pred['confidence']:.2f}")
        if escalated_from:
            detail = f"escalated from {escalated_from}: " + detail
        if self.single_channel:
            detail += "; single-channel board, kinetics only"
        self.on_event({"sense": "smell", "kind": kind, "severity": SEVERITY.get(kind, "warn"),
                       "label": LABELS.get(kind, kind), "detail": detail,
                       "data": {"probs": pred["probs"], "confidence": pred["confidence"],
                                "fingerprint": [round(x, 3) for x in self.ratios or []],
                                "fingerprint_shape": self.fingerprint, "deviation": round(dev, 3),
                                "urgency": urgency, "location": self.location,
                                "single_channel": self.single_channel, "escalated_from": escalated_from,
                                "calibration_quality": self.calibrator.quality}})

    def _relocate(self, location: str) -> None:
        """Readings now come from a different place. Keep what belongs to the sensor (its humidity
        slope), re-collect what belongs to the room (baseline, RH reference) over a few readings, and
        drop the anomaly bookkeeping so the new location is judged on its own signature. An open
        anomaly is closed with ``voc_clear`` (reason ``relocated``) so consumers see a clean state
        machine; the detail says it was left unresolved, not that the air cleared."""
        if self.anomaly is not None:
            prev = self.anomaly["kind"]
            self.on_event({"sense": "smell", "kind": "voc_clear", "severity": "info", "label": "Stopped watching",
                           "detail": f"{prev} at {self.location} left unresolved; sensor moved to {location}",
                           "data": {"previous": prev, "reason": "relocated", "location": self.location}})
        self.anomaly = None
        self._window.clear()
        self._devs.clear()       # the old room's deviation history must not make the new room look "falling"
        self.calibrator.rebase(self.rebase_samples)
        self._streak = self._quiet_streak = self._unknown_streak = 0
        self._streak_label = None
        self.status = "calibrating"
        self.probs = None
        self.prediction = None
        self.on_event({"sense": "smell", "kind": "relocated", "severity": "info",
                       "label": f"Nose now watching the {location}",
                       "detail": f"moved from {self.location}; re-baselining over {self.rebase_samples}+ readings (waits for a steady signal)",
                       "data": {"from": self.location, "to": location}})

    # ------------------------------------------------------------------ housekeeping
    def tick(self) -> None:
        if self.device != "none" and self._last_rx and time.monotonic() - self._last_rx > OFFLINE_AFTER_S:
            if self.status != "offline":
                self.on_event({"sense": "smell", "kind": "device_offline", "severity": "warn",
                               "label": "Nose offline", "detail": f"no readings for {OFFLINE_AFTER_S:.0f} s", "data": {}})
            self.status = "offline"
            self.anomaly = None

    def snapshot(self) -> dict:
        model = self.model.info() if self.model is not None else {"name": "gbdt-fingerprint", "features": 0,
                                                                   "trained_on": 0, "accuracy": 0.0}
        return {
            "device": self.device, "sensor_id": self.sensor_id, "location": self.location, "status": self.status,
            "single_channel": self.single_channel,
            "calibration": self.calibrator.snapshot(),
            "gas_ohm_steps": None if self.gas_steps is None else [round(x) for x in self.gas_steps],
            "temp_c": None if self.temp is None else round(self.temp, 1),
            "rh": None if self.rh is None else round(self.rh, 1),
            "ratios": None if self.ratios is None else [round(x, 3) for x in self.ratios],
            "ratio": None if self.ratios is None else round(self.ratios[2], 3),
            "fingerprint": self.fingerprint,
            "probs": self.probs,
            "prediction": None if self.prediction is None else self.prediction["label"],
            "anomaly": self.anomaly, "scenario": self.scenario,
            "trace": list(self.trace),
            "model": {"name": model["name"], "features": model["features"], "trained_on": model["trained_on"],
                      "accuracy": model["accuracy"]},
        }


# ---------------------------------------------------------------------- helpers
def _steps_from(r: dict):
    steps = r.get("gas_ohm_steps")
    if steps is not None:
        try:
            vals = [float(x) for x in steps]
        except (TypeError, ValueError):
            vals = []
        if len(vals) == 4 and all(v > 0 for v in vals):
            return vals, len(set(vals)) == 1          # four identical values carry no fingerprint
        if len(vals) == 1 and vals[0] > 0:
            return vals * 4, True
    g = _f(r.get("gas_ohm"))
    if g is None or g <= 0:
        return None, False
    return [g] * 4, True


def _shape(feats) -> list[float]:
    """Normalised log-ratio direction at peak deviation (features 7..10)."""
    return [round(float(x), 3) for x in feats[7:11]]


def _f(x) -> Optional[float]:
    try:
        return None if x is None else float(x)
    except (TypeError, ValueError):
        return None


def _fmt(ratios) -> str:
    return "[" + ", ".join(f"{x:.2f}" for x in (ratios or [])) + "]"
