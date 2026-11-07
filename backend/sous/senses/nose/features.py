"""Fixed-length feature vector over the last 30 s of compensated heater-sweep ratios.

Two kinds of information are summarised: the **fingerprint** (relative pattern across the four
heater steps - which gas family) and the **kinetics** (how fast it rose, how high, whether it is
decaying, whether temperature or humidity moved with it - which scenario). The classifier in
``model.py`` is trained on exactly this vector; ``FEATURE_NAMES`` documents every column.

Deviation is measured as ``max_step |log ratio|`` so an oxidising response (ratio < 1 at the cool
steps, chlorine) counts as much as a reducing one. When a legacy board sends one channel the four
steps are identical, the shape features are exactly zero and ``single_channel`` is 1, so the model
knows to lean on kinetics only.

Designed against the synthetic simulator; verify the choices on real logs before trusting them.
"""
from __future__ import annotations

import math
from typing import Sequence

import numpy as np

N_STEPS = 4
REFERENCE_STEP = 2
WINDOW_S = 30.0
ABOVE_THRESHOLD = 1.2          # "time above 1.2" on the reference step
DEVIATION_THRESHOLD = math.log(1.15)

FEATURE_NAMES: list[str] = (
    [f"ratio_now_s{i}" for i in range(N_STEPS)]
    + [f"shape_logdiff_s{i}" for i in (0, 1, 3)]          # log(r_i) - log(r_2) at peak deviation
    + [f"shape_dir_s{i}" for i in range(N_STEPS)]         # unit-normalised log-ratio direction at peak
    + ["rise_rate_max", "rise_rate_mean", "peak_deviation", "peak_ratio_s2", "time_above_1p2",
       "time_deviating", "temp_delta", "rh_delta", "decay_fraction", "time_since_peak", "single_channel"]
)
N_FEATURES = len(FEATURE_NAMES)


def deviation(ratios: Sequence[float]) -> float:
    """max_step |log ratio|: how far from clean air, sign-agnostic."""
    return float(max(abs(math.log(max(r, 1e-6))) for r in ratios))


def extract(window: Sequence[dict], single_channel: bool = False) -> np.ndarray:
    """``window``: chronological samples ``{t, ratios:[4], temp_c, rh}`` covering the last <=30 s."""
    n = len(window)
    out = np.zeros(N_FEATURES, dtype=float)
    if n == 0:
        out[:N_STEPS] = 1.0
        out[-1] = float(single_channel)
        return out
    t = np.array([float(w["t"]) for w in window])
    R = np.clip(np.array([w["ratios"] for w in window], dtype=float), 1e-6, None)
    L = np.log(R)                                   # (n, 4)
    dev = np.abs(L).max(axis=1)                     # (n,)
    # current ratios: median of the last 3 samples to shave noise
    out[0:4] = np.median(R[-3:], axis=0)
    # fingerprint at the moment of peak deviation (most signal, least noise-dominated)
    k = int(dev.argmax())
    lk = L[k]
    out[4:7] = [lk[0] - lk[2], lk[1] - lk[2], lk[3] - lk[2]]
    out[7:11] = lk / (np.linalg.norm(lk) + 0.03)
    if single_channel:
        out[4:11] = 0.0
    # kinetics on the deviation magnitude
    if n >= 2:
        span = 3.0
        rates = []
        for i in range(n):
            j = i
            while j > 0 and t[i] - t[j] < span:
                j -= 1
            if j < i and t[i] - t[j] > 0:
                rates.append((dev[i] - dev[j]) / (t[i] - t[j]))
        out[11] = max(rates) if rates else 0.0
        out[12] = (dev[-1] - dev[0]) / max(t[-1] - t[0], 1.0)
    out[13] = dev.max()
    out[14] = R[:, REFERENCE_STEP].max()
    dt = np.diff(t, prepend=t[0] - 1.0)
    out[15] = float(dt[R[:, REFERENCE_STEP] > ABOVE_THRESHOLD].sum())
    out[16] = float(dt[dev > DEVIATION_THRESHOLD].sum())
    temps = np.array([np.nan if w.get("temp_c") is None else float(w["temp_c"]) for w in window])
    rhs = np.array([np.nan if w.get("rh") is None else float(w["rh"]) for w in window])
    out[17] = _delta(temps, t, 20.0)
    out[18] = _delta(rhs, t, 20.0)
    peak = dev.max()
    out[19] = (peak - dev[-1]) / max(peak, 0.05) if peak > 0.05 else 0.0
    out[20] = float(t[-1] - t[k])
    out[21] = float(single_channel)
    return out


def _delta(series: np.ndarray, t: np.ndarray, back_s: float) -> float:
    ok = ~np.isnan(series)
    if ok.sum() < 2:
        return 0.0
    s, tt = series[ok], t[ok]
    now = np.median(s[-3:])
    then_idx = np.searchsorted(tt, tt[-1] - back_s)
    then = np.median(s[max(0, then_idx - 1):then_idx + 2])
    return float(now - then)
