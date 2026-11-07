"""ScentRoom: a 2D kitchen floor plan with several virtual noses, for demoing the nose (see
docs/SCENT_ROOM.md, which is the contract for this module).

A judge drops scent *sources* on the plan. Each source emits one gas family with first-order
kinetics; the concentration at each nose is a Gaussian plume ``exp(-d^2 / 2 sigma^2)`` times a wall
attenuation. Every nose has its own ``SensorPhysics`` (gain, base resistance, noise, drift) and its
own ``NosePipeline`` (calibration -> fingerprint -> classifier -> hysteresis), all sharing one loaded
``NoseModel``. Readings are built the way ``physics.Simulator.reading`` builds them.

Honesty: the noses never see what was dropped. Pipeline events are wrapped with a location estimate
(a plume-model fit to the noses' fingerprints) and the ingredient whose bin is nearest that estimate
(known shelving data), which is how a real multi-nose walk-in would infer *what* is turning.
"""
from __future__ import annotations

import itertools
import math
import random
import time
from typing import Callable, Optional

from .features import deviation
from .physics import (LOCATION_RH, LOCATION_TEMP_C, N_STEPS, REFERENCE_STEP, RESPONSE_EXPONENT,
                      SENSITIVITY, TEMP_SLOPE, SensorPhysics, mixture_ratio)
from .pipeline import LABELS, MIN_DEVIATION, NosePipeline

W, H = 100, 60

# ---------------------------------------------------------------------- tuning constants
SIGMA = 14.0                 # plume width (room units)
STRENGTH = 1.3               # source strength: ~1.2 at a nose 5 units away (mid range of trained scenarios)
ATT_ZONE = 0.5               # between two open zones
ATT_WALL = 0.04              # through the walk-in wall
ATT_DOOR = 0.35              # through the walk-in door gap
RISE_TAU = {"spoilage_produce": 8.0, "spoilage_protein": 8.0, "oil_degraded": 8.0, "burning": 4.0,
            "cleaning": 3.0}
DECAY_TAU = 4.0              # after removal / when a transient is spent (contract says ~8; 4 so the
                             # nose clears inside ~30 s even with a source right under it)
CLEANER_HOLD_S = 12.0
FRESH_FADE_S = 6.0
FRESH_BIN_RADIUS = 10.0      # a fresh tray dropped within this of a bin swaps that bin's tray
SWAP_RADIUS = 8.0            # ...removing bad sources within this of the bin
SOURCE_BIN_RADIUS = 8.0      # source.bin = nearest bin within this
MAX_SOURCES = 12
ENV_TAU = 5.0
GAIN_JITTER = 0.01           # room noses are span-calibrated: gain 1 +/- 1 % (localisation needs it)
# temperature / humidity transient at a nose per unit of (conc / 1.2), as in physics.SCENARIOS
ENV_COUPLING = {"burning": (6.0, 0.0), "oil_degraded": (1.5, 0.0), "cleaning": (0.0, 10.0),
                "spoilage_produce": (0.0, 2.0), "spoilage_protein": (0.0, 1.5)}
CONC_REF = 1.2

ZONES = [
    {"id": "walk-in", "label": "Walk-in cooler", "x": 0, "y": 0, "w": 30, "h": 32, "kind": "cold"},
    {"id": "dry", "label": "Dry storage", "x": 0, "y": 32, "w": 30, "h": 28, "kind": "dry"},
    {"id": "prep", "label": "Prep", "x": 30, "y": 0, "w": 32, "h": 30, "kind": "prep"},
    {"id": "line", "label": "Line", "x": 62, "y": 0, "w": 38, "h": 30, "kind": "hot"},
    {"id": "fry", "label": "Fry station", "x": 62, "y": 30, "w": 38, "h": 30, "kind": "hot"},
    {"id": "pass", "label": "Pass", "x": 30, "y": 30, "w": 32, "h": 30, "kind": "front"},
]
DOORS = [{"zone": "walk-in", "x": 30, "y1": 22, "y2": 30}]
BINS = [
    {"id": "bin-avocado", "ingredient": "avocado", "label": "Avocado", "x": 3, "y": 3, "zone": "walk-in", "category": "produce"},
    {"id": "bin-tomato", "ingredient": "tomato", "label": "Tomato", "x": 3, "y": 12, "zone": "walk-in", "category": "produce"},
    {"id": "bin-cheese", "ingredient": "cheese", "label": "Cheese", "x": 14, "y": 3, "zone": "walk-in", "category": "dairy"},
    {"id": "bin-eggs", "ingredient": "eggs", "label": "Eggs", "x": 22, "y": 3, "zone": "walk-in", "category": "protein"},
    {"id": "bin-chicken", "ingredient": "chicken", "label": "Chicken", "x": 3, "y": 19, "zone": "walk-in", "category": "protein"},
    {"id": "bin-carnitas", "ingredient": "carnitas", "label": "Carnitas", "x": 3, "y": 28, "zone": "walk-in", "category": "protein"},
    {"id": "bin-tortilla", "ingredient": "tortilla", "label": "Tortillas", "x": 6, "y": 38, "zone": "dry", "category": "dry"},
    {"id": "bin-sourdough", "ingredient": "sourdough", "label": "Sourdough", "x": 15, "y": 38, "zone": "dry", "category": "dry"},
    {"id": "bin-potatoes", "ingredient": "potatoes", "label": "Potatoes", "x": 6, "y": 52, "zone": "dry", "category": "dry"},
    {"id": "bin-salsa_verde", "ingredient": "salsa_verde", "label": "Salsa verde", "x": 70, "y": 4, "zone": "line", "category": "line"},
    {"id": "bin-horchata", "ingredient": "horchata", "label": "Horchata", "x": 92, "y": 4, "zone": "line", "category": "line"},
]
NOSES = [
    {"id": "walkin-produce", "label": "Walk-in · produce shelf", "x": 8, "y": 8, "zone": "walk-in", "location": "walk-in"},
    {"id": "walkin-protein", "label": "Walk-in · protein shelf", "x": 8, "y": 23, "zone": "walk-in", "location": "walk-in"},
    {"id": "line", "label": "Line", "x": 81, "y": 10, "zone": "line", "location": "line"},
    {"id": "fry", "label": "Fry station", "x": 81, "y": 50, "zone": "fry", "location": "fry-station"},
]
PALETTE = [
    {"kind": "spoiled_produce", "label": "Spoiled produce", "gas": "spoilage_produce", "good": False, "sustained": True,
     "desc": "Fermenting fruit/veg: ethanol and acetaldehyde, strongest on the hot heater steps."},
    {"kind": "spoiling_protein", "label": "Spoiling protein", "gas": "spoilage_protein", "good": False, "sustained": True,
     "desc": "Meat on the turn: amines and ammonia, strongest on the cool heater steps."},
    {"kind": "burnt_pan", "label": "Burnt pan", "gas": "burning", "good": False, "sustained": True,
     "desc": "Scorched pan: acrolein and smoke, fast rise with a heat bump."},
    {"kind": "old_fry_oil", "label": "Old fry oil", "gas": "oil_degraded", "good": False, "sustained": True,
     "desc": "Oxidised frying oil: aldehydes, mid-low heater steps."},
    {"kind": "cleaner_spray", "label": "Cleaner spray", "gas": "cleaning", "good": True, "sustained": False,
     "desc": "A spritz of sanitiser: chlorine spike with a humidity jump, gone in ~12 s. Benign."},
    {"kind": "fresh_produce", "label": "Fresh produce", "gas": None, "good": True, "sustained": False,
     "desc": "Drop on a produce bin to swap the tray: removes bad sources near that bin. Emits nothing."},
    {"kind": "fresh_protein", "label": "Fresh protein", "gas": None, "good": True, "sustained": False,
     "desc": "Drop on a protein bin to swap the tray: removes bad sources near that bin. Emits nothing."},
]
PALETTE_BY_KIND = {p["kind"]: p for p in PALETTE}
FRESH_CATEGORY = {"fresh_produce": "produce", "fresh_protein": "protein"}
INGREDIENT_CATEGORY = {"spoilage_produce": "produce", "spoilage_protein": "protein"}
# Placement prior: classes that need a heat source cannot plausibly originate at a nose installed in a
# cold room. The classifier is trained on single gases, so a mixture (say produce + protein in the
# walk-in) can land on "burning". Such a call is reported as "unknown" (or, if the nose already has an
# open anomaly, folded into it) instead of alerting the line.
IMPLAUSIBLE_BY_ZONE_KIND = {"cold": {"burning", "oil_degraded"}}
CONSEQUENCE = {"spoilage_produce": "{ing} flagged turning", "spoilage_protein": "{ing} flagged for a check",
               "burning": "line alerted", "oil_degraded": "oil change + reorder drafted",
               "cleaning": "benign, ignored", "unknown": "staff asked to look"}
SMELLS = {"spoilage_produce": "produce turning", "spoilage_protein": "protein spoiling",
          "burning": "burning", "oil_degraded": "degraded fry oil", "cleaning": "cleaning product",
          "unknown": "something it can't name"}


def _zone_at(x: float, y: float) -> str:
    for z in ZONES:
        if z["x"] <= x < z["x"] + z["w"] and z["y"] <= y < z["y"] + z["h"]:
            return z["id"]
    # on the far right/bottom edge
    for z in ZONES:
        if z["x"] <= x <= z["x"] + z["w"] and z["y"] <= y <= z["y"] + z["h"]:
            return z["id"]
    return "pass"


def _in_walkin(x: float, y: float) -> bool:
    return x < 30.0 and y < 32.0


def attenuation(x0: float, y0: float, x1: float, y1: float) -> float:
    """Wall attenuation between two points: 1 within a zone, ATT_ZONE between open zones, ATT_WALL
    through the walk-in wall, ATT_DOOR if the straight path crosses the walk-in door gap."""
    a_in, b_in = _in_walkin(x0, y0), _in_walkin(x1, y1)
    if a_in != b_in:
        # where does the segment cross the door plane x=30 (if it does, inside the door's span)?
        if (x0 - 30.0) * (x1 - 30.0) < 0:
            t = (30.0 - x0) / (x1 - x0)
            yc = y0 + t * (y1 - y0)
            if DOORS[0]["y1"] <= yc <= DOORS[0]["y2"]:
                return ATT_DOOR
        return ATT_WALL
    if a_in and b_in:
        return 1.0
    return 1.0 if _zone_at(x0, y0) == _zone_at(x1, y1) else ATT_ZONE


class _Source:
    __slots__ = ("id", "kind", "gas", "x", "y", "placed_t", "emission", "removed", "bin")

    def __init__(self, sid: str, kind: str, x: float, y: float, t: float):
        self.id, self.kind, self.x, self.y = sid, kind, x, y
        self.gas = PALETTE_BY_KIND[kind]["gas"]
        self.placed_t = t
        self.emission = 0.0
        self.removed = False
        self.bin: Optional[str] = None


class _Nose:
    def __init__(self, spec: dict, physics: SensorPhysics, rng: random.Random, pipeline: NosePipeline):
        self.spec = spec
        self.id = spec["id"]
        self.x, self.y = float(spec["x"]), float(spec["y"])
        self.location = spec["location"]
        self.physics = physics
        self.rng = rng
        self.p = pipeline
        self.drift = 0.0
        self.dtemp = 0.0
        self.drh = 0.0
        self.air: dict[str, float] = {}
        self.ingredient: Optional[str] = None        # ingredient inferred for the open anomaly
        self.reported: Optional[str] = None          # anomaly kind as reported (after the placement prior)
        zk = next((z["kind"] for z in ZONES if z["id"] == spec["zone"]), "")
        self.implausible = IMPLAUSIBLE_BY_ZONE_KIND.get(zk, set())
        self.est: Optional[tuple[float, float]] = None

    @property
    def ready(self) -> bool:
        return self.p.status in ("nominal", "anomaly")


class ScentRoom:
    def __init__(self, world=None, on_event: Optional[Callable[[dict], None]] = None,
                 model_provider: Optional[Callable[[], object]] = None, model=None, seed: int = 11):
        self.world = world
        self.on_event = on_event or (lambda e: None)
        self._model_provider = model_provider
        self._model = model
        self._seed = seed
        self._sseq = itertools.count(1)
        self.t = 0.0
        self.sources: list[_Source] = []
        self._ghosts: list[_Source] = []            # removed sources whose gas is still decaying
        self.inferences: list[dict] = []
        rng = random.Random(seed)
        self.noses: list[_Nose] = []
        for spec in NOSES:
            ph = SensorPhysics.sample(random.Random(rng.getrandbits(32)))
            ph.gain = 1.0 + rng.uniform(-GAIN_JITTER, GAIN_JITTER)
            nose_rng = random.Random(rng.getrandbits(32))
            nid = spec["id"]
            p = NosePipeline(on_event=lambda ev, nid=nid: self._pipe_event(nid, ev), model=model)
            self.noses.append(_Nose(spec, ph, nose_rng, p))
        self._by_id = {n.id: n for n in self.noses}

    # ------------------------------------------------------------------ static layout
    @staticmethod
    def layout() -> dict:
        return {"w": W, "h": H, "zones": ZONES, "doors": DOORS, "bins": BINS, "noses": NOSES}

    @staticmethod
    def palette() -> list[dict]:
        return PALETTE

    # ------------------------------------------------------------------ sources
    def add_source(self, kind: str, x: float, y: float) -> dict:
        if kind not in PALETTE_BY_KIND:
            raise ValueError(f"unknown kind {kind!r}")
        if len(self.sources) >= MAX_SOURCES:
            raise OverflowError(f"at most {MAX_SOURCES} sources")
        x, y = _clamp(x, 0, W), _clamp(y, 0, H)
        s = _Source(f"s{next(self._sseq)}", kind, x, y, self.t)
        s.bin = self._bin_near(x, y, SOURCE_BIN_RADIUS)
        self.sources.append(s)
        if kind in FRESH_CATEGORY:
            self._swap_tray(s)
        return self._src_dict(s)

    def move_source(self, sid: str, x: float, y: float) -> Optional[dict]:
        s = self._find(sid)
        if s is None:
            return None
        s.x, s.y = _clamp(x, 0, W), _clamp(y, 0, H)
        s.bin = self._bin_near(s.x, s.y, SOURCE_BIN_RADIUS)
        if s.kind in FRESH_CATEGORY:
            self._swap_tray(s)
        return self._src_dict(s)

    def remove_source(self, sid: str) -> bool:
        s = self._find(sid)
        if s is None:
            return False
        self._retire(s)
        return True

    def reset(self) -> None:
        """Remove every source (and its lingering gas) immediately; noses keep their calibration and
        clear on their own over the next few seconds."""
        self.sources.clear()
        self._ghosts.clear()

    def reset_all(self) -> None:
        """Hub reset: sources and the inference log go; nose calibration is kept."""
        self.reset()
        self.inferences.clear()

    def _find(self, sid: str) -> Optional[_Source]:
        return next((s for s in self.sources if s.id == sid), None)

    def _retire(self, s: _Source) -> None:
        if s in self.sources:
            self.sources.remove(s)
        s.removed = True
        if s.gas and s.emission > 1e-3:
            self._ghosts.append(s)

    def _swap_tray(self, s: _Source) -> None:
        cat = FRESH_CATEGORY[s.kind]
        b = self._nearest_bin(s.x, s.y, cat, FRESH_BIN_RADIUS)
        if b is None:
            return
        s.bin = b["ingredient"]
        for o in list(self.sources):
            if o is not s and not PALETTE_BY_KIND[o.kind]["good"] and math.hypot(o.x - b["x"], o.y - b["y"]) <= SWAP_RADIUS:
                self._retire(o)

    @staticmethod
    def _nearest_bin(x: float, y: float, category: Optional[str] = None, radius: float = math.inf) -> Optional[dict]:
        best, bd = None, radius
        for b in BINS:
            if category and b["category"] != category:
                continue
            d = math.hypot(b["x"] - x, b["y"] - y)
            if d <= bd:
                best, bd = b, d
        return best

    def _bin_near(self, x: float, y: float, radius: float) -> Optional[str]:
        b = self._nearest_bin(x, y, None, radius)
        return b["ingredient"] if b else None

    # ------------------------------------------------------------------ 1 Hz step
    def _ensure_model(self):
        if self._model is None and self._model_provider is not None:
            self._model = self._model_provider()
        if self._model is not None:
            for n in self.noses:
                n.p.model = self._model
        return self._model

    def step(self) -> None:
        """Advance one simulated second: source kinetics, air at each nose, one reading per nose."""
        self._ensure_model()
        self.t += 1.0
        for s in self.sources + self._ghosts:
            self._kinetics(s)
        self._ghosts = [g for g in self._ghosts if g.emission > 1e-3]
        for s in list(self.sources):
            if s.kind == "cleaner_spray" and self.t - s.placed_t > CLEANER_HOLD_S and s.emission < 0.02:
                self.sources.remove(s)
            elif s.kind in FRESH_CATEGORY and self.t - s.placed_t >= FRESH_FADE_S:
                self.sources.remove(s)
        for n in self.noses:
            n.air = self._air_at(n.x, n.y)
            n.p.ingest(self._reading(n))

    def _kinetics(self, s: _Source) -> None:
        if not s.gas:
            return
        on = not s.removed and (s.kind != "cleaner_spray" or self.t - s.placed_t <= CLEANER_HOLD_S)
        tau = RISE_TAU.get(s.gas, 6.0) if on else DECAY_TAU
        a = 1.0 - math.exp(-1.0 / tau)
        s.emission += a * ((1.0 if on else 0.0) - s.emission)

    def _air_at(self, x: float, y: float) -> dict[str, float]:
        air: dict[str, float] = {}
        for s in self.sources + self._ghosts:
            if not s.gas or s.emission <= 1e-4:
                continue
            d2 = (s.x - x) ** 2 + (s.y - y) ** 2
            c = s.emission * STRENGTH * math.exp(-d2 / (2 * SIGMA * SIGMA)) * attenuation(s.x, s.y, x, y)
            if c > 1e-5:
                air[s.gas] = air.get(s.gas, 0.0) + c
        return air

    def _reading(self, n: _Nose) -> dict:
        """Like ``physics.Simulator.reading``, with the concentration dict from the room's air. Gas
        reaches the film only once the nose has a clean-air baseline (sources placed during
        calibration wait)."""
        ph, r = n.physics, n.rng
        concs = n.air if n.ready else {}
        dtemp_t = sum(ENV_COUPLING.get(g, (0, 0))[0] * min(1.5, c / CONC_REF) for g, c in concs.items())
        drh_t = sum(ENV_COUPLING.get(g, (0, 0))[1] * min(1.5, c / CONC_REF) for g, c in concs.items())
        b = 1.0 - math.exp(-1.0 / ENV_TAU)
        n.dtemp += b * (dtemp_t - n.dtemp)
        n.drh += b * (drh_t - n.drh)
        n.drift = 0.995 * n.drift + r.gauss(0.0, ph.drift_sd)
        temp = LOCATION_TEMP_C[n.location] + n.dtemp + r.gauss(0.0, 0.05)
        rh = LOCATION_RH[n.location] + n.drh + r.gauss(0.0, 0.3)
        ratios = mixture_ratio(concs, ph.gain)
        env = math.exp(n.drift - ph.rh_slope * (rh - ph.rh_ref) - TEMP_SLOPE * (temp - ph.temp_ref))
        steps = [ph.base_ohm[i] * env / ratios[i] * (1.0 + r.gauss(0.0, ph.noise_sd)) for i in range(N_STEPS)]
        return {"t": self.t, "gas_ohm": round(steps[REFERENCE_STEP], 1), "gas_ohm_steps": [round(x, 1) for x in steps],
                "temp_c": round(temp, 2), "rh": round(rh, 2), "sensor_id": f"room-{n.id}",
                "location": n.location, "source": "room"}

    # ------------------------------------------------------------------ inference
    def _conc_estimate(self, n: _Nose, kind: str) -> float:
        """Invert the MOX response for one nose: least-squares ``conc ** 0.6`` along the class's
        sensitivity vector, assuming the factory gain of 1. Uses only the nose's own ratios."""
        win = list(n.p._window)[-3:]             # average the last 3 s to beat noise
        if not win:
            return 0.0
        r = [sum(w["ratios"][i] for w in win) / len(win) for i in range(N_STEPS)]
        sv = SENSITIVITY.get(kind)
        if sv and any(sv):
            a = sum(s * (x - 1.0) for s, x in zip(sv, r)) / sum(s * s for s in sv)
        else:
            a = max(abs(x - 1.0) for x in r)
        return max(a, 0.0) ** (1.0 / RESPONSE_EXPONENT)

    def estimate_location(self, kind: str) -> Optional[tuple[float, float]]:
        """Where is the plume coming from? Noses at/above the anomaly floor are fitted with the
        plume model (Gaussian, wall attenuation, unknown source strength) over a 1-unit grid, lightly
        regularised toward their concentration-weighted centroid; noses below the floor only say
        "not much here". With a single nose above the floor this is that nose's position (the
        contract's weighted centroid). Two noses fix the position along the line between them."""
        ests = {n.id: self._conc_estimate(n, kind) for n in self.noses if n.p.ratios}
        devs = {n.id: deviation(n.p.ratios) for n in self.noses if n.p.ratios}
        active = [n for n in self.noses if devs.get(n.id, 0.0) >= MIN_DEVIATION and ests.get(n.id, 0.0) > 1e-4]
        if not active:
            return None
        wsum = sum(ests[n.id] for n in active)
        cx = sum(n.x * ests[n.id] for n in active) / wsum
        cy = sum(n.y * ests[n.id] for n in active) / wsum
        if len(active) == 1:
            return (round(cx, 1), round(cy, 1))
        quiet = [n for n in self.noses if n not in active and n.p.ratios]
        c_floor = (math.exp(MIN_DEVIATION) - 1.0) ** (1.0 / RESPONSE_EXPONENT)
        best, best_cost = (cx, cy), math.inf
        ln_max = math.log(3 * STRENGTH)
        for gx in range(0, W + 1):
            for gy in range(0, H + 1):
                lg = []
                for n in active:
                    att = attenuation(gx, gy, n.x, n.y)
                    lg.append(-((gx - n.x) ** 2 + (gy - n.y) ** 2) / (2 * SIGMA * SIGMA) + math.log(att))
                resid = [math.log(ests[n.id]) - g for n, g in zip(active, lg)]
                lnA = sum(resid) / len(resid)
                cost = sum((x - lnA) ** 2 for x in resid)
                if lnA > ln_max:
                    cost += (lnA - ln_max) ** 2
                for n in quiet:
                    pred = lnA - ((gx - n.x) ** 2 + (gy - n.y) ** 2) / (2 * SIGMA * SIGMA) + math.log(attenuation(gx, gy, n.x, n.y))
                    excess = pred - math.log(c_floor)
                    if excess > 0:
                        cost += excess ** 2
                cost += 1e-4 * ((gx - cx) ** 2 + (gy - cy) ** 2)
                if cost < best_cost:
                    best, best_cost = (gx, gy), cost
        return (round(float(best[0]), 1), round(float(best[1]), 1))

    def _pipe_event(self, nid: str, ev: dict) -> None:
        n = self._by_id[nid]
        d = dict(ev.get("data") or {})
        d["nose_id"] = nid
        d["source"] = "room"
        d["nose_label"] = n.spec["label"]
        kind = ev["kind"]
        ev = dict(ev, data=d)
        if kind in ("device_connected", "device_offline", "relocated"):
            ev["label"] = f"{n.spec['label']}: {ev.get('label', '')}"
            self.on_event(ev)
            return
        if kind == "voc_clear":
            prev = n.reported or d.get("previous")
            d["previous"] = prev
            n.reported = None
            d["ingredient"] = n.ingredient
            d["still_active"] = any(o is not n and o.reported == prev
                                    and o.ingredient == n.ingredient for o in self.noses)
            ev["label"] = f"Air cleared at {n.spec['label']}"
            self._log(n, "voc_clear", f"{n.spec['label']}: {SMELLS.get(prev, prev)} gone"
                      + (f"; {_pretty(n.ingredient)} back to fresh" if n.ingredient and not d["still_active"] else "")
                      + ("; another nose still smells it" if d["still_active"] else ""),
                      label="Air cleared", est=None, ingredient=n.ingredient)
            n.ingredient, n.est = None, None
            self.on_event(ev)
            return
        if kind in n.implausible:
            if n.reported is not None:
                return                                  # a mixture shifted the call; keep the open anomaly
            d["reclassified_from"] = kind
            # renormalise the posterior over the classes this placement allows; take the best if it is clear
            probs = {k: float(v) for k, v in (d.get("probs") or {}).items() if k not in n.implausible}
            tot = sum(probs.values())
            best = max((k for k in probs if k not in ("nominal", "unknown")), key=probs.get, default=None)
            kind = best if (best and tot > 0 and probs[best] / tot >= 0.5) else "unknown"
            if kind == n.reported:
                return
            ev["kind"] = kind
            ev["label"] = LABELS.get(kind, kind)
            if kind in probs and tot > 0:
                d["confidence"] = round(probs[kind] / tot, 4)
        if kind == n.reported:
            return
        n.reported = kind
        # an anomaly: estimate where, infer which ingredient (sticky across noses on one plume)
        peer = next((o for o in self.noses if o is not n and o.reported == kind
                     and o.est is not None), None)
        if peer is not None:
            est, ing = peer.est, peer.ingredient
        else:
            est = self.estimate_location(kind) or (n.x, n.y)
            ing = None
            cat = INGREDIENT_CATEGORY.get(kind)
            if cat:
                # only stock shelved in the zone the plume comes from can be blamed: a protein smell
                # out in prep is not the eggs behind the walk-in wall
                zone = _zone_at(est[0], est[1])
                b = self._nearest_bin(est[0], est[1], cat)
                ing = b["ingredient"] if (b and b["zone"] == zone) else None
        n.est, n.ingredient = est, ing
        d["est_xy"] = [est[0], est[1]]
        d["ingredient"] = ing
        zid = _zone_at(est[0], est[1])
        d["zone"] = zid
        d["zone_label"] = next(z["label"] for z in ZONES if z["id"] == zid)
        ev["label"] = f"{ev.get('label', LABELS.get(kind, kind))} · {n.spec['label']}"
        where = f"plume nearest the {_pretty(ing)} bin" if ing else f"plume near ({est[0]:.0f}, {est[1]:.0f})"
        summary = (f"{n.spec['label']} smells {SMELLS.get(kind, kind)}; {where} -> "
                   + ("nothing shelved there to blame, staff asked to look" if (not ing and kind in INGREDIENT_CATEGORY)
                      else CONSEQUENCE.get(kind, "logged").format(ing=_pretty(ing) if ing else "stock")))
        self._log(n, kind, summary, label=LABELS.get(kind, kind), est=est, ingredient=ing)
        self.on_event(ev)

    def _log(self, n: _Nose, kind: str, summary: str, label: str, est, ingredient) -> None:
        self.inferences.insert(0, {"t": time.strftime("%H:%M:%S"), "nose_id": n.id, "kind": kind, "label": label,
                                   "est_x": None if est is None else est[0], "est_y": None if est is None else est[1],
                                   "ingredient": ingredient, "summary": summary})
        del self.inferences[12:]

    # ------------------------------------------------------------------ snapshot
    def _src_dict(self, s: _Source) -> dict:
        return {"id": s.id, "kind": s.kind, "label": PALETTE_BY_KIND[s.kind]["label"], "x": round(s.x, 1),
                "y": round(s.y, 1), "age_s": round(self.t - s.placed_t, 1), "emission": round(s.emission, 3),
                "bin": s.bin}

    def snapshot(self) -> dict:
        noses = []
        for n in self.noses:
            p = n.p
            pred = p.prediction
            an = dict(p.anomaly, kind=n.reported) if (p.anomaly and n.reported) else p.anomaly
            noses.append({
                "id": n.id, "label": n.spec["label"], "x": n.x, "y": n.y, "location": n.location,
                "status": p.status if p.status in ("nominal", "anomaly") else "calibrating",
                "deviation": round(deviation(p.ratios), 3) if p.ratios else 0.0,
                "ratios": [round(x, 3) for x in p.ratios] if p.ratios else [1.0] * 4,
                "prediction": None if pred is None else {"label": pred["label"], "confidence": round(float(pred["confidence"]), 3)},
                "anomaly": None if an is None else {"kind": an["kind"], "label": LABELS.get(an["kind"], an["kind"]),
                                                    "confidence": round(float(an["confidence"]), 3),
                                                    "urgency": an["urgency"]},
                "air": {g: round(c, 3) for g, c in n.air.items() if c >= 1e-3},
            })
        inv = []
        if self.world is not None:
            for i in self.world.inventory.values():
                if i.location == "walk-in":
                    inv.append({"name": i.name, "label": _pretty(i.name), "freshness": i.freshness,
                                "on_hand": round(i.on_hand, 1), "unit": i.unit, "location": i.location})
        return {"sources": [self._src_dict(s) for s in self.sources], "noses": noses,
                "inferences": list(self.inferences), "inventory": inv}


def _pretty(name: Optional[str]) -> str:
    if not name:
        return ""
    from ...sim.menu_data import pretty
    return pretty(name)


def _clamp(v: float, lo: float, hi: float) -> float:
    try:
        v = float(v)
    except (TypeError, ValueError):
        v = lo
    return max(lo, min(hi, v))
