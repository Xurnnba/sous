"""Evaluate the nose: train/load the fingerprint model, report held-out accuracy and confusion
matrix, then replay every simulator scenario through the full NosePipeline and report which event
fired and how many seconds after stimulus onset. door_open and nominal are negatives (no event
allowed). Then checks the legacy single-channel path still separates spoilage from burning, replays
a long sequential demo, and runs the ``sequence`` test: the demo buttons pressed back to back with
25 s gaps on ONE pipeline (the way a judge clicks through them), where each press may move the
sensor and so trigger a relocation rebase while the previous scenario's gas is still in the air.

Run: cd backend && ../.venv/bin/python tests/eval_nose.py [--retrain] [--seeds N] [--seq-seeds N]
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

# Judge's button order (reported live); None = no anomaly event allowed while that scenario is up.
SEQUENCE = [("spoilage_walkin", "spoilage_produce"), ("burning", "burning"), ("cleaning", "cleaning"),
            ("nominal", None), ("fryer_oil", "oil_degraded"), ("door_open", None),
            ("spoilage_protein", "spoilage_protein")]
SEQ_GAP_S = 25            # seconds between presses
SEQ_MAX_LATENCY_S = 20    # hard limit: event within this long after the stimulus actually starts
SEQ_TARGET_LATENCY_S = 10  # soft target, reported


def run_sequence(model, seed: int, sampled_physics: bool, gap: int = SEQ_GAP_S, warmup: int = 30):
    """Press SEQUENCE on one pipeline with ``gap`` s between presses (1 Hz readings + tick, as the API
    loop does). Returns (ok, rows, all_events). Each scenario must produce exactly its expected
    anomaly event, after its stimulus starts and within SEQ_MAX_LATENCY_S of it, and nothing else
    (tails of the previous scenario included) before the next press; negatives must produce none."""
    events = []
    p = NosePipeline(lambda e: events.append(dict(e, _t=sim._t)), model=model)
    physics = SensorPhysics.sample(random.Random(seed)) if sampled_physics else None
    sim = Simulator(p, seed=seed, physics=physics)
    sim.set_scenario("nominal")              # the API autostarts the nose on clean air
    for _ in range(warmup):
        sim.step()
        p.tick()
    rows, ok_all = [], True
    for scen, expect in SEQUENCE:
        press = sim._t
        sim.set_scenario(scen)
        n0 = len(events)
        for _ in range(gap):
            sim.step()
            p.tick()
        onset = sim.onset_t                  # final value: the simulator may hold the stimulus during a rebase
        seg = [e for e in events[n0:] if e["kind"] in ANOMALY_KINDS]
        if expect is None:
            ok = not seg
            lat = None
        else:
            ok = (len(seg) == 1 and seg[0]["kind"] == expect and onset <= seg[0]["_t"] <= onset + SEQ_MAX_LATENCY_S)
            lat = seg[0]["_t"] - onset if seg else None
        ok_all &= ok
        rows.append({"scenario": scen, "expect": expect, "press": press, "onset_delay": onset - press,
                     "fired": [f"{e['kind']}@{e['_t'] - onset:+.0f}s" for e in seg], "latency": lat, "ok": ok})
    return ok_all, rows, events


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
    ap.add_argument("--seq-seeds", type=int, default=5,
                    help="sequence-test seeds, each run with the live default sensor and a sampled one")
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

    print("\n== sequential demo on one pipeline (relocation, clear, no flapping) ==")
    plan = [("spoilage_walkin", 60), ("stop", 5), ("nominal", 25), ("burning", 70), ("cleaning", 70),
            ("door_open", 60), ("fryer_oil", 90), ("spoilage_protein", 60)]
    want = ["spoilage_produce", "voc_clear", "burning", "voc_clear", "cleaning", "voc_clear", "oil_degraded", "voc_clear",
            "spoilage_protein"]
    events = []
    p = NosePipeline(lambda e: events.append(dict(e, _t=sim._t)), model=model)
    sim = Simulator(p, seed=11)
    for scen, secs in plan:
        sim.set_scenario(scen)
        for _ in range(secs):
            sim.step()
            p.tick()
    got = [e["kind"] for e in events if e["kind"] not in ("device_connected", "relocated")]
    for e in events:
        print(f"  t={e['_t']:>4.0f}  {e['kind']:<17} {e['severity']:<5} {e['data'].get('urgency', '-'):<5} {e['detail'][:80]}")
    ok = got == want
    if not ok:
        failures += 1
    print(f"  sequence {'ok' if ok else 'FAIL'}: got {got}")
    cal = p.snapshot()["calibration"]
    print(f"  calibration after run: rh_slope={cal['rh_slope']} fitted={cal['rh_slope_fitted']} quality={cal['quality']}")

    print(f"\n== sequence test: judge's button order, {SEQ_GAP_S} s gaps, one pipeline ==")
    print(f"   expect each scenario's class within {SEQ_MAX_LATENCY_S} s of stimulus onset (target "
          f"<{SEQ_TARGET_LATENCY_S} s), no events on nominal/door_open or from tails")
    worst = 0.0
    for sampled in (False, True):
        for seed in range(1, args.seq_seeds + 1):
            ok, rows, _ = run_sequence(model, seed, sampled_physics=sampled)
            if not ok:
                failures += 1
            cells = []
            for r in rows:
                fired = ",".join(r["fired"]) or "-"
                cells.append(f"{r['scenario']}[+{r['onset_delay']:.0f}]:{fired}{'' if r['ok'] else '!!'}")
                if r["latency"] is not None:
                    worst = max(worst, r["latency"])
            tag = "sampled" if sampled else "default"
            print(f"  seed {seed} {tag:<7} {'ok  ' if ok else 'FAIL'} " + "  ".join(cells))
    print(f"  ([+N] = s from press to stimulus onset; event times relative to onset) worst latency {worst:.0f}s"
          + ("" if worst <= SEQ_TARGET_LATENCY_S else f"  WARNING above {SEQ_TARGET_LATENCY_S}s target"))

    snap = p.snapshot()
    print("\nsnapshot keys:", sorted(snap.keys()))
    print("calibration:", snap["calibration"])
    print(f"\n{'ALL OK' if failures == 0 else f'{failures} FAILURE(S)'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
