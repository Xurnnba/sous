"""Evaluate the nose: train/load the fingerprint model, report held-out accuracy and confusion
matrix, then replay every simulator scenario through the full NosePipeline and report which event
fired and how many seconds after stimulus onset. door_open and nominal are negatives (no event
allowed). Finally checks the legacy single-channel path still separates spoilage from burning.

Run: cd backend && ../.venv/bin/python tests/eval_nose.py [--retrain] [--seeds N]
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sous.senses.nose.model import NoseModel, format_confusion  # noqa: E402
from sous.senses.nose.physics import SCENARIO_CLASS, Simulator, SensorPhysics  # noqa: E402
from sous.senses.nose.pipeline import NosePipeline  # noqa: E402

import random  # noqa: E402

EXPECT = {  # scenario -> set of acceptable first anomaly kinds (None = no event allowed)
    "spoilage_walkin": {"spoilage_produce"}, "spoilage_protein": {"spoilage_protein"},
    "fryer_oil": {"oil_degraded"}, "burning": {"burning"}, "cleaning": {"cleaning"},
    "door_open": None, "nominal": None, "breath": None,
}
LEGACY_EXPECT = {"spoilage_walkin": {"spoilage_produce", "spoilage_protein"}, "burning": {"burning"}}
ANOMALY_KINDS = {"spoilage_produce", "spoilage_protein", "burning", "oil_degraded", "cleaning", "unknown"}


def run_scenario(model, scenario: str, seed: int, single_channel: bool = False, duration: int = 150):
    events = []
    p = NosePipeline(lambda e: events.append(dict(e, _t=sim._t)), model=model)
    rng = random.Random(seed)
    sim = Simulator(p, seed=seed, physics=SensorPhysics.sample(rng), single_channel=single_channel)
    sim.set_scenario(scenario)
    for _ in range(duration):
        sim.step()
    anomalies = [e for e in events if e["kind"] in ANOMALY_KINDS]
    clears = [e for e in events if e["kind"] == "voc_clear"]
    return sim, anomalies, clears, p


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--retrain", action="store_true")
    ap.add_argument("--seeds", type=int, default=3, help="replays per scenario")
    args = ap.parse_args()

    model = NoseModel().load_or_train(force=args.retrain)
    print(f"\nmodel: {model.info()}")
    print(f"held-out accuracy: {model.accuracy:.3f}")
    print(format_confusion(model.confusion, model.classes))

    failures = 0
    print("\n== pipeline replay (4-step heater sweep) ==")
    print(f"{'scenario':<18}{'seed':>5}  {'expected':<18}{'fired':<18}{'latency':>8}  {'conf':>5}  cleared  note")
    for scen, expect in EXPECT.items():
        for seed in range(1, args.seeds + 1):
            sim, anomalies, clears, p = run_scenario(model, scen, seed)
            fired = anomalies[0]["kind"] if anomalies else "-"
            lat = f"{anomalies[0]['_t'] - sim.onset_t:.0f}s" if anomalies else "-"
            conf = f"{anomalies[0]['data']['confidence']:.2f}" if anomalies else ""
            cleared = f"{clears[0]['_t'] - sim.onset_t:.0f}s" if clears else "-"
            extra = ""
            if len(anomalies) > 1:
                extra = "then " + ", ".join(f"{a['kind']}@{a['_t'] - sim.onset_t:.0f}s" for a in anomalies[1:])
            ok = (not anomalies) if expect is None else (bool(anomalies) and fired in expect and len(anomalies) == 1)
            if not ok:
                failures += 1
            exp_str = "no event" if expect is None else "/".join(sorted(expect))
            print(f"{scen:<18}{seed:>5}  {exp_str:<18}{fired:<18}{lat:>8}  {conf:>5}  {cleared:<8} "
                  f"{'ok' if ok else 'FAIL'} {extra} params={ {k: round(v, 1) for k, v in sim.params.items() if isinstance(v, float)} }")

    print("\n== legacy single-channel path (gas_ohm only, fingerprint neutral) ==")
    for scen, expect in LEGACY_EXPECT.items():
        for seed in range(1, args.seeds + 1):
            sim, anomalies, clears, p = run_scenario(model, scen, seed + 100, single_channel=True)
            fired = anomalies[0]["kind"] if anomalies else "-"
            lat = f"{anomalies[0]['_t'] - sim.onset_t:.0f}s" if anomalies else "-"
            ok = bool(anomalies) and fired in expect
            if not ok:
                failures += 1
            sc = anomalies[0]["data"]["single_channel"] if anomalies else None
            print(f"{scen:<18}{seed:>5}  {'/'.join(sorted(expect)):<34}{fired:<18}{lat:>8}  single_channel={sc} {'ok' if ok else 'FAIL'}")

    snap = p.snapshot()
    print("\nsnapshot keys:", sorted(snap.keys()))
    print("calibration:", snap["calibration"])
    print(f"\n{'ALL OK' if failures == 0 else f'{failures} FAILURE(S)'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
