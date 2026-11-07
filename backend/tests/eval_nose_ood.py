"""Out-of-distribution robustness for the nose: sensors and gas fingerprints the classifier never saw.

The model trains on gains 0.6-1.6, noise 0.5-1.0 %, and the nominal SENSITIVITY vectors. Here we run
the full pipeline on sensors with gain 0.4 and 2.2, noise 2 %, drift 3x, and per-step sensitivity
jittered by +/-25 % (a different sensor batch), and ask: does each scenario still produce exactly its
own class, and do the nuisances still produce nothing?  Run: ../.venv/bin/python tests/eval_nose_ood.py
"""
from __future__ import annotations
import math, os, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
from sous.senses.nose import physics as P
from sous.senses.nose.pipeline import NosePipeline

EXPECT = {"spoilage_walkin": "spoilage_produce", "spoilage_protein": "spoilage_protein", "fryer_oil": "oil_degraded",
          "burning": "burning", "cleaning": "cleaning", "door_open": None, "nominal": None, "breath": None}

def run(gain, noise, drift, jitter, seed):
    rng = random.Random(seed)
    base = P.SensorPhysics.sample(rng)
    phys = P.SensorPhysics(gain=gain, base_ohm=base.base_ohm, rh_slope=base.rh_slope, noise_sd=noise, drift_sd=drift)
    saved = dict(P.SENSITIVITY)
    P.SENSITIVITY.update({k: tuple(v * math.exp(rng.uniform(-jitter, jitter)) for v in vec)
                          for k, vec in saved.items() if k != "nominal"})
    ok = total = 0
    rows = []
    try:
        for scen, want in EXPECT.items():
            events = []
            pipe = NosePipeline(on_event=lambda e: events.append(e))
            sim = P.Simulator(pipe, seed=seed, physics=phys)
            sim.set_scenario("nominal")
            for _ in range(20): sim.step(); pipe.tick()
            sim.set_scenario(scen)
            for _ in range(60): sim.step(); pipe.tick()
            kinds = [e["kind"] for e in events if e["kind"] not in ("device_connected", "relocated", "voc_clear", "device_offline")]
            good = (kinds == [want]) if want else (kinds == [])
            ok += good; total += 1
            rows.append(f"{scen:17s} -> {kinds or ['-']}{'' if good else '   <-- expected ' + str(want)}")
    finally:
        P.SENSITIVITY.update(saved)
    return ok, total, rows

def main():
    grand_ok = grand_total = 0
    for gain, noise, drift, jitter in [(0.4, 0.02, 0.0045, 0.25), (2.2, 0.02, 0.0045, 0.25), (1.0, 0.02, 0.0045, 0.35), (0.5, 0.012, 0.003, 0.0)]:
        for seed in (11, 12, 13):
            ok, total, rows = run(gain, noise, drift, jitter, seed)
            grand_ok += ok; grand_total += total
            print(f"gain {gain} noise {noise*100:.0f}% drift x3 jitter ±{int(jitter*100)}% seed {seed}: {ok}/{total}")
            for r in rows:
                if "<--" in r: print("    " + r)
    print(f"\nOOD total: {grand_ok}/{grand_total} scenarios correct")

if __name__ == "__main__":
    main()
