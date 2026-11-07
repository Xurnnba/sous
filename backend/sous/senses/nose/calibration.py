"""Self-calibration for a heater-sweep MOX sensor: per-step clean-air baseline, humidity
compensation with an online-fitted slope, slow drift tracking, and a calibration-quality score.

Absolute ohms mean nothing across sensors or days; everything downstream works on the
dimensionless per-step ratio ``baseline / R_compensated``. The calibrator is what makes that ratio
trustworthy:

* **Baseline.** Median of the first ``warmup_samples`` readings per step (status ``warming`` ->
  ``ready``). With real hardware the heater needs ~5 min to settle, so use ~300; the demo uses 12.
* **Slow adaptation.** While the classifier says nominal the baseline tracks the compensated signal
  with a long time constant so a shift's drift is not an alarm. It is frozen during an anomaly so a
  slow rise cannot hide itself. The pipeline owns that gate; ``adapt(..., nominal=...)`` just obeys.
* **Humidity.** MOX resistance falls as RH rises (~0.8 %/%RH is the prior). Over nominal readings
  we fit ``log R_step2 = a - slope * RH`` by exponentially-forgotten least squares and blend the
  fitted slope with the prior as evidence accumulates. A fit is only trusted once the RH range
  covered is wide enough; a door-open transient is, usefully, what provides that range.
* **Quality** (0-1): how many nominal samples have been seen and how much RH range they span.
  It is a self-assessment of the calibration, not of the sensor.

Tuned on the synthetic simulator in ``physics.py``; real sensor logs must replace those settings.
"""
from __future__ import annotations

import math
from typing import Optional, Sequence

N_STEPS = 4
REFERENCE_STEP = 2
RH_SLOPE_PRIOR = 0.008
RH_SLOPE_MIN, RH_SLOPE_MAX = 0.0, 0.02
PRIOR_WEIGHT = 25.0        # equivalent nominal samples the prior slope is worth
FORGET = 0.995             # per-sample forgetting for the slope fit (~200 s memory)
MIN_RH_RANGE_FOR_FIT = 1.5  # %RH weighted std before the fit is used


class Calibrator:
    def __init__(self, warmup_samples: int = 12, rh_slope: float = RH_SLOPE_PRIOR, adapt_rate: float = 0.005):
        self.warmup_samples = warmup_samples
        self.prior_slope = rh_slope
        self.adapt_rate = adapt_rate
        self.reset()

    def reset(self) -> None:
        self.status = "warming"
        self.baseline: Optional[list[float]] = None
        self.baseline_init: Optional[list[float]] = None
        self.rh_ref: Optional[float] = None
        self.rh_slope = self.prior_slope
        self.rh_slope_fitted = False
        self.n_nominal = 0
        self.rh_min = math.inf
        self.rh_max = -math.inf
        self._warm: list[list[float]] = []
        self._warm_rh: list[float] = []
        # exponentially forgotten sums for the slope fit
        self._sw = self._sx = self._sy = self._sxx = self._sxy = 0.0

    # ------------------------------------------------------------------ properties
    @property
    def samples_remaining(self) -> int:
        return max(0, self.warmup_samples - len(self._warm))

    @property
    def drift_pct(self) -> float:
        """Baseline movement at the reference step since calibration, in percent."""
        if not self.baseline or not self.baseline_init:
            return 0.0
        return (self.baseline[REFERENCE_STEP] / self.baseline_init[REFERENCE_STEP] - 1.0) * 100.0

    @property
    def rh_range(self) -> float:
        return 0.0 if self.rh_max < self.rh_min else self.rh_max - self.rh_min

    @property
    def quality(self) -> float:
        if self.status != "ready":
            return 0.0
        return round(min(1.0, 0.6 * min(1.0, self.n_nominal / 120.0) + 0.4 * min(1.0, self.rh_range / 8.0)), 3)

    # ------------------------------------------------------------------ core
    def compensate(self, steps: Sequence[float], rh: Optional[float]) -> Optional[list[float]]:
        """Per-step ratio ``baseline / R_compensated``. While warming, accumulates the sample and
        returns ``None``; the moment the baseline is set it returns ratios (close to 1.0)."""
        steps = [max(float(s), 1.0) for s in steps]
        if self.baseline is None:
            self._warm.append(steps)
            if rh is not None:
                self._warm_rh.append(float(rh))
            if len(self._warm) >= self.warmup_samples:
                cols = list(zip(*self._warm))
                self.baseline = [_median(c) for c in cols]
                self.baseline_init = list(self.baseline)
                self.rh_ref = _median(self._warm_rh) if self._warm_rh else None
                self.status = "ready"
            else:
                return None
        corr = self._rh_factor(rh)
        return [b / (s * corr) for b, s in zip(self.baseline, steps)]

    def _rh_factor(self, rh: Optional[float]) -> float:
        if rh is None or self.rh_ref is None:
            return 1.0
        return math.exp(self.rh_slope * (float(rh) - self.rh_ref))

    def adapt(self, steps: Sequence[float], rh: Optional[float], nominal: bool) -> None:
        """Feed a reading the pipeline has judged nominal (or not). Only nominal readings move the
        baseline or the humidity fit; anomalous ones are ignored entirely."""
        if self.baseline is None or not nominal:
            return
        self.n_nominal += 1
        corr = self._rh_factor(rh)
        for i, s in enumerate(steps):
            self.baseline[i] += self.adapt_rate * (max(float(s), 1.0) * corr - self.baseline[i])
        if rh is None:
            return
        rh = float(rh)
        self.rh_min, self.rh_max = min(self.rh_min, rh), max(self.rh_max, rh)
        y = math.log(max(float(steps[REFERENCE_STEP]), 1.0))
        f = FORGET
        self._sw, self._sx, self._sy = f * self._sw + 1, f * self._sx + rh, f * self._sy + y
        self._sxx, self._sxy = f * self._sxx + rh * rh, f * self._sxy + rh * y
        if self._sw < 20:
            return
        mx, my = self._sx / self._sw, self._sy / self._sw
        var = self._sxx / self._sw - mx * mx
        if var < MIN_RH_RANGE_FOR_FIT ** 2:
            return
        cov = self._sxy / self._sw - mx * my
        fitted = max(RH_SLOPE_MIN, min(RH_SLOPE_MAX, -cov / var))
        self.rh_slope = (self.prior_slope * PRIOR_WEIGHT + fitted * self._sw) / (PRIOR_WEIGHT + self._sw)
        self.rh_slope_fitted = True

    def snapshot(self) -> dict:
        return {
            "status": self.status,
            "warmup": {"have": len(self._warm), "need": self.warmup_samples},
            "baseline_ohm": None if self.baseline is None else [round(b) for b in self.baseline],
            "baseline_ohm_step2": None if self.baseline is None else round(self.baseline[REFERENCE_STEP]),
            "rh_ref": None if self.rh_ref is None else round(self.rh_ref, 1),
            "rh_slope": round(self.rh_slope, 5),
            "rh_slope_fitted": self.rh_slope_fitted,
            "rh_range": round(self.rh_range, 1),
            "drift_pct": round(self.drift_pct, 2),
            "n_nominal": self.n_nominal,
            "quality": self.quality,
        }


def _median(xs: Sequence[float]) -> float:
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])
