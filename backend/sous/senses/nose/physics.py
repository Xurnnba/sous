"""Physically grounded MOX heater-sweep simulator: synthetic training data and the live demo replay.

HONESTY NOTE. Everything in this module is a model, not a measurement. It bootstraps the classifier
so the rest of the system (pipeline, UI, agent) can be built and demonstrated before a sensor board
exists. The first thing to do with real hardware is log labelled episodes (see docs/ENOSE.md,
"Validation plan") and retrain ``NoseModel`` on those; the synthetic generator then becomes an
augmentation source at best.

What is modelled, and why
-------------------------
A Bosch BME688 can step its heater through several temperatures and report one gas resistance per
step. We use four steps (200, 250, 320, 400 degC). Different gas families oxidise on the tin-oxide
film at different temperatures, so the *relative* pattern across the four steps is a crude chemical
fingerprint. This is how Bosch's BSEC "gas scan" mode works.

* Reducing gases (ethanol/acetaldehyde from fermenting produce, amines/ammonia from spoiling
  protein, acrolein/aldehydes from burning or degraded fry oil) donate electrons and LOWER the
  resistance, so ``ratio = baseline / R`` goes above 1.
* Oxidising gases (chlorine from cleaning products) trap electrons and RAISE resistance at the
  steps where they adsorb, so the ratio drops below 1 there.

Response model per step: ``ratio_step = 1 + gain * s_step * conc ** 0.6`` (power-law MOX response,
exponent ~0.5-0.7 in the literature). ``s_step`` is a per-class sensitivity vector, ``gain`` is a
per-sensor manufacturing factor (0.6-1.6). Concentration follows first-order rise/decay kinetics per
scenario, with time constants compressed for the demo clock (spoilage that takes hours in a real
cooler plays out in tens of seconds here). On top: baseline drift (random walk in log space),
0.5-1 % multiplicative noise, humidity cross-sensitivity (resistance falls ~0.8 %/%RH), a small
ambient-temperature effect, and nuisance events that must be classified nominal (door-open
humidity/temperature transient, a person breathing near the sensor).
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Optional

HEATER_STEPS_C = (200, 250, 320, 400)
N_STEPS = 4
REFERENCE_STEP = 2                      # the step we report as the legacy single ``gas_ohm``
RESPONSE_EXPONENT = 0.6                 # ratio - 1 ~ conc ** 0.6
RH_SLOPE_NOMINAL = 0.008                # resistance falls ~0.8 % per %RH
TEMP_SLOPE = 0.002                      # ~0.2 % per degC ambient (heater is regulated; small)
BASE_OHM_STEP2 = 180_000.0
BASE_PROFILE = (1.80, 1.35, 1.00, 0.65)  # hotter film -> lower clean-air resistance
LOCATION_TEMP_C = {"walk-in": 3.5, "fry-station": 31.0, "line": 27.0}
LOCATION_RH = {"walk-in": 62.0, "fry-station": 42.0, "line": 48.0}

CLASSES = ("nominal", "spoilage_produce", "spoilage_protein", "burning", "oil_degraded", "cleaning")

# Per-step relative sensitivity (ratio_step - 1 at unit concentration, gain 1).
# >0: reducing gas (R falls). <0: oxidising gas (R rises). Patterns are plausible, not measured.
SENSITIVITY = {
    "spoilage_produce": (0.30, 0.55, 0.85, 1.00),    # ethanol/acetaldehyde: best oxidised on a hot film
    "spoilage_protein": (1.00, 0.80, 0.50, 0.25),    # amines/ammonia: adsorb and react on the cool steps
    "burning":         (0.55, 0.90, 1.00, 0.70),     # acrolein + smoke/CO: mid-high, broad
    "oil_degraded":    (0.75, 1.00, 0.70, 0.35),     # aldehydes from oxidised oil: mid-low
    "cleaning":        (-0.30, -0.20, 0.10, 0.35),   # chlorine oxidises (R up) when cool; carriers reduce when hot
    "nominal":         (0.0, 0.0, 0.0, 0.0),
}

# Scenario kinetics (demo clock, seconds). Ranges are sampled per episode so the classifier does
# not learn one fixed curve. conc: target concentration (arbitrary units, see RESPONSE_EXPONENT).
# hold: seconds at target before decaying (None = sustained). decay_tau: first-order decay.
SCENARIOS: dict[str, dict] = {
    "spoilage_walkin":  dict(cls="spoilage_produce", gas="spoilage_produce", location="walk-in",
                             conc=(0.5, 1.8), tau=(12, 30), hold=None, decay_tau=None,
                             dtemp=(0.0, 0.0), drh=(1.0, 4.0), env_tau=8.0),
    "spoilage_protein": dict(cls="spoilage_protein", gas="spoilage_protein", location="walk-in",
                             conc=(0.5, 1.8), tau=(10, 25), hold=None, decay_tau=None,
                             dtemp=(0.0, 0.0), drh=(0.0, 3.0), env_tau=8.0),
    "fryer_oil":        dict(cls="oil_degraded", gas="oil_degraded", location="fry-station",
                             conc=(0.35, 1.1), tau=(30, 60), hold=None, decay_tau=None,
                             dtemp=(1.0, 2.5), drh=(0.0, 0.0), env_tau=15.0),
    "burning":          dict(cls="burning", gas="burning", location="line",
                             conc=(1.5, 6.0), tau=(1.0, 3.0), hold=(15, 30), decay_tau=(8, 15),
                             dtemp=(4.0, 8.0), drh=(0.0, 0.0), env_tau=5.0),
    "cleaning":         dict(cls="cleaning", gas="cleaning", location="walk-in",
                             conc=(0.8, 3.0), tau=(1.5, 3.0), hold=(5, 12), decay_tau=(10, 20),
                             dtemp=(0.0, 0.0), drh=(8.0, 15.0), env_tau=3.0),
    # nuisance events: must be classified nominal
    "door_open":        dict(cls="nominal", gas="spoilage_produce", location="walk-in",
                             conc=(0.0, 0.03), tau=(2.0, 4.0), hold=(8, 20), decay_tau=(4, 8),
                             dtemp=(2.0, 5.0), drh=(6.0, 12.0), env_tau=3.0),
    "breath":           dict(cls="nominal", gas="spoilage_produce", location="line",
                             conc=(0.02, 0.08), tau=(1.0, 2.0), hold=(2, 5), decay_tau=(2, 4),
                             dtemp=(0.0, 0.5), drh=(1.0, 3.0), env_tau=2.0),
    "nominal":          dict(cls="nominal", gas="nominal", location="walk-in",
                             conc=(0.0, 0.0), tau=(10, 10), hold=None, decay_tau=None,
                             dtemp=(0.0, 0.0), drh=(0.0, 0.0), env_tau=5.0),
}
SCENARIO_CLASS = {name: s["cls"] for name, s in SCENARIOS.items()}
RESIDUAL_TAU_S = 10.0     # decay of gas left by a sustained scenario when another one starts in the same room
ONSET_MARGIN_S = 4.0      # seconds of clean air after the baseline is ready before a stimulus starts
DEMO_SCENARIOS = ("spoilage_walkin", "spoilage_protein", "fryer_oil", "burning", "cleaning",
                  "door_open", "nominal")


def response_ratio(gas: str, conc: float, gain: float) -> list[float]:
    """Per-step ``baseline / R`` for ``conc`` of gas family ``gas`` on a sensor with ``gain``."""
    return mixture_ratio({gas: conc}, gain)


def mixture_ratio(concs: dict, gain: float) -> list[float]:
    """Per-step ``baseline / R`` for several gas families at once. Each family's response
    ``gain * s_step * conc ** 0.6`` is summed per step (a first-order approximation; real films
    interact non-linearly) and the ratio is floored at 0.25."""
    out = [1.0] * N_STEPS
    for gas, conc in concs.items():
        if conc <= 0.0 or gas == "nominal":
            continue
        c = conc ** RESPONSE_EXPONENT
        for i, sv in enumerate(SENSITIVITY[gas]):
            out[i] += gain * sv * c
    return [max(0.25, r) for r in out]


@dataclass
class SensorPhysics:
    """One physical sensor: manufacturing gain, clean-air resistance per step, its own humidity
    slope and noise level. Sampled per episode so the model sees a population, not one board."""
    gain: float = 1.0
    base_ohm: list[float] = field(default_factory=lambda: [BASE_OHM_STEP2 * p for p in BASE_PROFILE])
    rh_slope: float = RH_SLOPE_NOMINAL
    noise_sd: float = 0.007
    drift_sd: float = 0.0015          # per-second random-walk step in log(R)
    rh_ref: float = 60.0
    temp_ref: float = 20.0

    @classmethod
    def sample(cls, rng: random.Random) -> "SensorPhysics":
        scale = math.exp(rng.gauss(0.0, 0.25))                     # unit-to-unit absolute resistance
        profile = [p * math.exp(rng.gauss(0.0, 0.05)) for p in BASE_PROFILE]
        return cls(gain=rng.uniform(0.6, 1.6),
                   base_ohm=[BASE_OHM_STEP2 * scale * p for p in profile],
                   rh_slope=rng.uniform(0.006, 0.010),
                   noise_sd=rng.uniform(0.005, 0.010),
                   drift_sd=rng.uniform(0.0005, 0.0025))


class Simulator:
    """Synthesises BME688 heater-sweep readings at 1 Hz.

    ``step()`` returns a reading dict ``{t, gas_ohm_steps:[4], gas_ohm, temp_c, rh, sensor_id,
    location, source}`` and, if a pipeline was given, pushes it through ``pipeline.ingest`` exactly as
    the HTTP endpoint would. ``set_scenario(name)`` accepts the names in ``SCENARIOS`` plus ``"stop"``.
    If the pipeline has no baseline yet the stimulus is held back until it does (plus a few seconds),
    otherwise the baseline would be contaminated - same behaviour as the old single-channel simulator.
    The hold is re-checked every step, so a re-baseline that takes longer than expected still gets
    clean air.

    Switching scenario does not re-label gas already in the air: whatever the previous scenario left
    behind becomes a *residual* of its own gas family that keeps decaying with that scenario's decay
    time constant (``RESIDUAL_TAU_S`` if it had none) and adds to the response. Pressing ``nominal``
    during a cleaning spike therefore shows the chlorine tail fading, not an instant step to clean
    air. A scenario at a different location moves the sensor to another room: the old room's gas
    and its temperature/humidity transient are left behind (ambient becomes the new room's), so the
    pipeline re-baselines on that room's clean air. Film desorption after a move (seconds on a
    real sensor) is not modelled.
    """

    def __init__(self, pipeline=None, seed: int = 3, physics: Optional[SensorPhysics] = None,
                 single_channel: bool = False, sensor_id: str = "sim-bme688"):
        self.p = pipeline
        self.rng = random.Random(seed)
        self.physics = physics or SensorPhysics()
        self.single_channel = single_channel
        self.sensor_id = sensor_id
        self.running = False
        self.scenario: Optional[str] = None
        self.location = "walk-in"
        self.onset_t: Optional[float] = None
        self._t = 0.0
        self._conc = 0.0
        self._gas = "nominal"
        self._drift = 0.0
        self._dtemp = 0.0
        self._drh = 0.0
        self._params: dict = {}
        self._residual: dict[str, list[float]] = {}   # gas -> [conc, decay_tau] left by earlier scenarios

    # ------------------------------------------------------------------ control
    def set_scenario(self, name: str) -> None:
        if name == "stop":
            self.running = False
            self.scenario = None
            if self.p is not None:
                self.p.scenario = None
            return
        if name not in SCENARIOS:
            raise ValueError(f"unknown scenario {name!r}; choose from {sorted(SCENARIOS)}")
        s = SCENARIOS[name]
        r = self.rng
        self.running = True
        self.scenario = name
        if self.p is not None:
            self.p.scenario = name
        if s["location"] != self.location:
            # different room: the old room's gas and its temp/RH transient stay behind
            self._residual.clear()
            self._dtemp = self._drh = 0.0
        elif self._conc > 1e-4 and self._gas != "nominal":
            # same room: what the previous scenario put in the air stays and decays as itself
            old_tau = self._params.get("decay_tau") or RESIDUAL_TAU_S
            prev = self._residual.get(self._gas, [0.0, old_tau])
            self._residual[self._gas] = [prev[0] + self._conc, max(prev[1], old_tau)]
        self._conc = 0.0
        self.location = s["location"]
        self._gas = s["gas"]
        self._params = dict(
            conc=r.uniform(*s["conc"]), tau=r.uniform(*s["tau"]),
            hold=None if s["hold"] is None else r.uniform(*s["hold"]),
            decay_tau=None if s["decay_tau"] is None else r.uniform(*s["decay_tau"]),
            dtemp=r.uniform(*s["dtemp"]), drh=r.uniform(*s["drh"]), env_tau=s["env_tau"])
        # Hold the stimulus until the pipeline has a clean-air baseline for this location: during the
        # initial warm-up, and again after a move (the pipeline re-baselines on relocation).
        delay = 0.0
        if self.p is not None:
            cal = getattr(self.p, "calibrator", None)
            if cal is not None and cal.status != "ready":
                delay = cal.samples_remaining + ONSET_MARGIN_S
            elif getattr(self.p, "location", self.location) != self.location:
                delay = getattr(self.p, "rebase_samples", 6) + ONSET_MARGIN_S
        self.onset_t = self._t + delay

    @property
    def params(self) -> dict:
        return dict(self._params)

    # ------------------------------------------------------------------ 1 Hz step
    def step(self) -> Optional[dict]:
        if not self.running:
            return None
        self._t += 1.0
        # still re-baselining (e.g. the calibrator is waiting for a stable signal): keep holding
        cal = getattr(self.p, "calibrator", None) if self.p is not None else None
        if (cal is not None and cal.status != "ready" and self.onset_t is not None
                and self._t >= self.onset_t - ONSET_MARGIN_S):
            self.onset_t = self._t + ONSET_MARGIN_S
        rd = self.reading(self._t)
        if self.p is not None:
            self.p.ingest(rd)
        return rd

    def reading(self, t: float) -> dict:
        """Advance the internal physics by one second and emit the reading at time ``t``."""
        ph, r, pr = self.physics, self.rng, self._params
        elapsed = t - (self.onset_t if self.onset_t is not None else t)
        if elapsed < 0 or not pr:
            target_c, tau, dtemp_t, drh_t, env_tau = 0.0, 5.0, 0.0, 0.0, 5.0
        elif pr["hold"] is not None and elapsed > pr["hold"]:
            target_c, tau, dtemp_t, drh_t, env_tau = 0.0, pr["decay_tau"], 0.0, 0.0, pr["env_tau"]
        else:
            target_c, tau, dtemp_t, drh_t, env_tau = pr["conc"], pr["tau"], pr["dtemp"], pr["drh"], pr["env_tau"]
        # first-order kinetics for concentration and for the environmental transient
        a = 1.0 - math.exp(-1.0 / max(tau, 0.1))
        self._conc += a * (target_c - self._conc)
        b = 1.0 - math.exp(-1.0 / max(env_tau, 0.1))
        self._dtemp += b * (dtemp_t - self._dtemp)
        self._drh += b * (drh_t - self._drh)
        for gas in list(self._residual):
            c, rtau = self._residual[gas]
            c *= math.exp(-1.0 / max(rtau, 0.1))
            if c < 1e-4:
                del self._residual[gas]
            else:
                self._residual[gas][0] = c
        # slow baseline drift: random walk in log space, mildly mean-reverting so it stays bounded
        self._drift = 0.995 * self._drift + r.gauss(0.0, ph.drift_sd)

        temp = LOCATION_TEMP_C[self.location] + self._dtemp + r.gauss(0.0, 0.05)
        rh = LOCATION_RH[self.location] + self._drh + r.gauss(0.0, 0.3)
        concs = {g: c for g, (c, _) in self._residual.items()}
        concs[self._gas] = concs.get(self._gas, 0.0) + self._conc
        ratios = mixture_ratio(concs, ph.gain)
        env = math.exp(self._drift - ph.rh_slope * (rh - ph.rh_ref) - TEMP_SLOPE * (temp - ph.temp_ref))
        steps = [ph.base_ohm[i] * env / ratios[i] * (1.0 + r.gauss(0.0, ph.noise_sd)) for i in range(N_STEPS)]
        rd = {"t": t, "gas_ohm": round(steps[REFERENCE_STEP], 1),
              "temp_c": round(temp, 2), "rh": round(rh, 2), "sensor_id": self.sensor_id,
              "location": self.location, "source": "replay", "true_conc": round(self._conc, 4),
              "residual_conc": round(sum(concs.values()) - self._conc, 4)}
        if not self.single_channel:          # a legacy board posts only ``gas_ohm``
            rd["gas_ohm_steps"] = [round(x, 1) for x in steps]
        return rd


# ---------------------------------------------------------------------- synthetic training set
def _episode_scenarios(rng: random.Random) -> list[str]:
    """Scenario list for one balanced pass: every class once, nuisance events included in nominal."""
    return ["spoilage_walkin", "spoilage_protein", "fryer_oil", "burning", "cleaning",
            rng.choice(["nominal", "door_open", "breath", "door_open", "breath"])]


NUISANCE_PREFIXES = ("door_open", "breath", "nominal")
ANOMALY_PREFIXES = ("spoilage_walkin", "spoilage_protein", "fryer_oil", "burning", "cleaning")


def generate_windows(n: int, rng: random.Random, windows_per_episode: int = 3,
                     single_channel_frac: float = 0.30, warmup_samples: int = 12,
                     sequence_frac: float = 0.35):
    """Return ``(X, y)``: ``n`` feature vectors (see ``features.extract``) and class labels.

    Each episode: a fresh sensor (``SensorPhysics.sample``), a ``Calibrator`` warmed on clean air,
    then one scenario. Several windows are cut at random times after onset so the model sees the
    rise, the plateau and (for burning/cleaning) the decay. A window is labelled with the scenario's
    class only if the compensated fingerprint actually deviates from clean air at the window's end
    (max |log ratio| > log 1.12); before that it is, truthfully, still nominal. Nuisance scenarios are
    always nominal. A fraction of episodes replicate step 2 to all four steps and set the
    single-channel flag, so the model also learns to fall back on kinetics for legacy boards.

    A further ``sequence_frac`` of episodes mimic someone pressing demo buttons back to back in one
    room: a *prefix* scenario runs for 8-30 s before the episode's scenario starts, and its gas and
    temp/RH transient carry over (see ``Simulator``). For an anomaly scenario the prefix is a
    nuisance (door open, breath, plain clean air), so the model sees a real onset on top of a
    settling humidity transient. For a nominal-class scenario the prefix may be an anomaly, so the
    model sees that anomaly's decaying tail; those windows keep the prefix's class while the
    deviation is above the label threshold (it is still that gas) and are nominal below it.
    """
    import numpy as np
    from .calibration import Calibrator
    from .features import extract, deviation

    X, y = [], []
    label_threshold = math.log(1.12)
    while len(X) < n:
        for scen in _episode_scenarios(rng):
            if len(X) >= n:
                break
            s = SCENARIOS[scen]
            single = rng.random() < single_channel_frac
            sim = Simulator(None, seed=rng.getrandbits(32), physics=SensorPhysics.sample(rng), single_channel=single)
            cal = Calibrator(warmup_samples=warmup_samples)
            sim.set_scenario("nominal")
            sim.location = s["location"]          # warm up where the scenario happens (no location jump)
            # warm-up and a little clean air so the calibrator is ready before onset
            pre = warmup_samples + rng.randint(2, 12)
            hist: list[dict] = []
            for _ in range(pre):
                rd = sim.step()
                steps = rd.get("gas_ohm_steps") or [rd["gas_ohm"]] * N_STEPS
                ratios = cal.compensate(steps, rd["rh"])
                if ratios is not None:
                    cal.adapt(steps, rd["rh"], nominal=True)
                    hist.append({"t": rd["t"], "ratios": ratios, "temp_c": rd["temp_c"], "rh": rd["rh"]})
            # optional prefix scenario in the same room (back-to-back button presses)
            label_cls = s["cls"]
            if rng.random() < sequence_frac:
                prefix = rng.choice(NUISANCE_PREFIXES if s["cls"] != "nominal" else ANOMALY_PREFIXES + NUISANCE_PREFIXES)
                pcls = SCENARIOS[prefix]["cls"]
                if pcls != "nominal":
                    label_cls = pcls                  # the tail is still the prefix's gas
                sim.set_scenario(prefix)
                sim.location = s["location"]          # same room: no relocation
                for _ in range(rng.randint(8, 30)):
                    rd = sim.step()
                    steps = rd.get("gas_ohm_steps") or [rd["gas_ohm"]] * N_STEPS
                    ratios = cal.compensate(steps, rd["rh"])
                    cal.adapt(steps, rd["rh"], nominal=pcls == "nominal" or deviation(ratios) < 0.05)
                    hist.append({"t": rd["t"], "ratios": ratios, "temp_c": rd["temp_c"], "rh": rd["rh"]})
            sim.set_scenario(scen)
            dur = 100 if s["hold"] is None else int(s["hold"][1] + 3 * (s["decay_tau"][1] if s["decay_tau"] else 0) + 10)
            dur = min(max(dur, 40), 110)
            onset = sim.onset_t
            # one window always in the first seconds after onset (where detection must happen), the
            # rest anywhere in the episode (plateau, decay)
            cut_at = sorted([rng.uniform(onset + 3, onset + 10)]
                            + [rng.uniform(onset + 3, onset + dur) for _ in range(windows_per_episode - 1)])
            ci = 0
            for _ in range(dur):
                rd = sim.step()
                steps = rd.get("gas_ohm_steps") or [rd["gas_ohm"]] * N_STEPS
                ratios = cal.compensate(steps, rd["rh"])
                truly_nominal = label_cls == "nominal" or deviation(ratios) < 0.05
                cal.adapt(steps, rd["rh"], nominal=truly_nominal)
                hist.append({"t": rd["t"], "ratios": ratios, "temp_c": rd["temp_c"], "rh": rd["rh"]})
                while ci < len(cut_at) and rd["t"] >= cut_at[ci]:
                    ci += 1
                    window = [h for h in hist if h["t"] > rd["t"] - 30.0]
                    if len(window) < 6:
                        continue
                    dev = deviation(window[-1]["ratios"])
                    label = label_cls if (label_cls != "nominal" and dev > label_threshold) else "nominal"
                    X.append(extract(window, single_channel=single))
                    y.append(label)
    return np.asarray(X[:n], dtype=float), np.asarray(y[:n], dtype=object)
