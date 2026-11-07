"""Evaluate the scent room headlessly (no server): World + ScentRoom (real NoseModel) + Brain, stepped in
simulated seconds. For each case a source is dropped at a sensible spot, the room runs ~60 s, and we
record which nose raised which event (with the inferred ingredient and latency); then the source is
removed and every nose that raised must clear (voc_clear) within CLEAR_LIMIT_S. Brain side effects
(freshness flags, push discounts, freshness restored) are checked for the ingredient cases.

Run: cd backend && ../.venv/bin/python tests/eval_room.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sous.agent.brain import Brain, PUSH_DISCOUNT_PCT  # noqa: E402
from sous.agent.items import ItemStore  # noqa: E402
from sous.senses.nose.model import NoseModel  # noqa: E402
from sous.senses.nose.room import BINS, CLEANER_HOLD_S, ScentRoom  # noqa: E402
from sous.sim.world import World  # noqa: E402

DETECT_LIMIT_S = 25
CLEAR_LIMIT_S = 30
RUN_S = 60
SETTLE_S = 45
ANOMALY = {"spoilage_produce", "spoilage_protein", "burning", "oil_degraded", "cleaning", "unknown"}
WALKIN = {"walkin-produce", "walkin-protein"}
BIN_XY = {b["ingredient"]: (b["x"], b["y"]) for b in BINS}

# name, kind, (x, y), expected kind or None, expected ingredient, noses allowed to raise, extra
CASES = [
    ("spoiled produce @ avocado bin", "spoiled_produce", BIN_XY["avocado"], "spoilage_produce", "avocado", WALKIN, {}),
    ("spoiled produce @ tomato bin", "spoiled_produce", BIN_XY["tomato"], "spoilage_produce", "tomato", WALKIN, {}),
    ("spoiling protein @ chicken bin", "spoiling_protein", BIN_XY["chicken"], "spoilage_protein", "chicken", WALKIN, {}),
    ("spoiling protein @ carnitas bin", "spoiling_protein", BIN_XY["carnitas"], "spoilage_protein", "carnitas", WALKIN, {}),
    ("burnt pan on the line", "burnt_pan", (75, 14), "burning", None, {"line"}, {}),
    ("old fry oil at the fry station", "old_fry_oil", (76, 47), "oil_degraded", None, {"fry"}, {}),
    ("cleaner spray in the walk-in", "cleaner_spray", (15, 15), "cleaning?", None, WALKIN, {"transient": True}),
    ("spoiled produce in dry storage", "spoiled_produce", (10, 45), None, None, set(), {}),
    ("spoiling protein at the pass", "spoiling_protein", (46, 45), None, None, set(), {}),
    ("spoiled produce in prep", "spoiled_produce", (45, 12), None, None, set(), {}),
    ("fresh produce on avocado bin", "fresh_produce", BIN_XY["avocado"], None, None, set(), {"transient": True}),
    ("spoiled avocado, then fresh tray swap", "spoiled_produce", BIN_XY["avocado"], "spoilage_produce", "avocado",
     WALKIN, {"swap": "fresh_produce"}),
    # mixtures are outside the single-gas training set; a walk-in nose must never call them burning/oil
    ("produce + protein mixed in the walk-in", "spoiled_produce", BIN_XY["avocado"], "mix", None, WALKIN,
     {"also": ("spoiling_protein", BIN_XY["chicken"])}),
    ("produce + protein dropped together", "spoiled_produce", BIN_XY["tomato"], "mix", None, WALKIN,
     {"also": ("spoiling_protein", BIN_XY["chicken"]), "also_at": 1}),
]


async def main() -> int:
    model = NoseModel().load_or_train(verbose=False)
    world = World()
    events: list[tuple[float, dict]] = []
    actions: list[dict] = []
    tmp = Path(tempfile.mkdtemp())
    items = ItemStore(tmp / "items.json", on_change=lambda it, ch: None)
    seq = [0]

    async def speak(_text: str) -> None:
        return None

    brain = Brain(world, None, None, items, emit_action=actions.append, speak=speak, emit_event=lambda e: None)

    def on_event(ev: dict) -> None:
        seq[0] += 1
        ev = dict(ev, id=f"e{seq[0]}")
        events.append((room.t, ev))
        brain.on_smell_event(ev)

    room = ScentRoom(world, on_event=on_event, model=model, seed=int(os.environ.get("ROOM_SEED", "11")))

    async def run(n: int) -> None:
        for _ in range(n):
            room.step()
            await asyncio.sleep(0)
            await asyncio.sleep(0)

    await run(25)                       # calibration on clean air
    assert all(n.p.status == "nominal" for n in room.noses), [n.p.status for n in room.noses]
    calib = {n.id: n.p.status for n in room.noses}

    rows, failures = [], []
    for name, kind, (x, y), exp_kind, exp_ing, allowed, extra in CASES:
        room.reset()
        await run(SETTLE_S if events else 0)
        if any(n.p.anomaly for n in room.noses):
            await run(30)
        n0 = len(events)
        src = room.add_source(kind, x, y)
        t_drop = room.t
        also = None
        if extra.get("also"):
            await run(extra.get("also_at", 12))
            k2, (x2, y2) = extra["also"]
            also = room.add_source(k2, x2, y2)
        await run(RUN_S)
        fresh_mid = None
        if exp_ing and exp_kind == "spoilage_produce":
            inv = world.inventory[exp_ing]
            fresh_mid = [m.id for m in world.items_using(exp_ing) if m.discount_pct == PUSH_DISCOUNT_PCT]
            turning_ok = inv.freshness == "turning" and bool(fresh_mid)
        elif exp_ing and exp_kind == "spoilage_protein":
            turning_ok = world.inventory[exp_ing].freshness == "watch"
        else:
            turning_ok = True
        # a transient is "removed" when it is spent (cleaner: after its hold), not by us
        t_remove = t_drop + (CLEANER_HOLD_S if kind == "cleaner_spray" else 0) if extra.get("transient") else room.t
        if extra.get("swap"):
            room.add_source(extra["swap"], x, y)
            swapped = all(s.id != src["id"] for s in room.sources)
        else:
            swapped = True
            if not extra.get("transient"):
                room.remove_source(src["id"])
            if also:
                room.remove_source(also["id"])
        await run(CLEAR_LIMIT_S + 5)
        evs = events[n0:]
        raised = [(t, e) for t, e in evs if e["kind"] in ANOMALY]
        clears = [(t, e) for t, e in evs if e["kind"] == "voc_clear"]
        # assessment
        problems = []
        kinds = {e["kind"] for _, e in raised}
        noses = {e["data"]["nose_id"] for _, e in raised}
        if exp_kind is None:
            if raised:
                problems.append(f"unexpected {sorted(kinds)} from {sorted(noses)}")
        elif exp_kind == "mix":
            if not raised:
                problems.append("no detection")
            if kinds - {"spoilage_produce", "spoilage_protein", "unknown"}:
                problems.append(f"mixture raised {sorted(kinds)}")
        elif exp_kind == "cleaning?":
            if kinds - {"cleaning"}:
                problems.append(f"cleaner raised {sorted(kinds)}")
        else:
            if not raised:
                problems.append("no detection")
            else:
                if kinds != {exp_kind}:
                    problems.append(f"kinds {sorted(kinds)} != {exp_kind}")
                if noses - allowed:
                    problems.append(f"raised by {sorted(noses - allowed)}")
                lat = raised[0][0] - t_drop
                if lat > DETECT_LIMIT_S:
                    problems.append(f"latency {lat:.0f}s")
                ings = {e["data"].get("ingredient") for _, e in raised}
                if exp_ing and ings != {exp_ing}:
                    problems.append(f"ingredient {sorted(map(str, ings))} != {exp_ing}")
        for nid in noses:
            c = [t for t, e in clears if e["data"]["nose_id"] == nid and t > t_remove]
            if not c:
                problems.append(f"{nid} did not clear")
            elif c[0] - t_remove > CLEAR_LIMIT_S:
                problems.append(f"{nid} cleared {c[0] - t_remove:.0f}s after removal")
        if not turning_ok:
            problems.append(f"brain did not flag {exp_ing}")
        if exp_ing and raised:
            inv = world.inventory[exp_ing]
            if inv.freshness != "fresh":
                problems.append(f"{exp_ing} still {inv.freshness} after clear")
            if fresh_mid and any(world.menu[m].discount_pct for m in fresh_mid):
                problems.append("push discount not cleared")
            if not any(a["type"] == "freshness_restored" and a["payload"].get("ingredient") == exp_ing for a in actions):
                problems.append("no freshness_restored action")
        if not swapped:
            problems.append("fresh tray did not remove the spoiled source")
        open_room_items = [i for i in items.open_items() if i["evidence"].get("source") == "room"
                           and i["kind"] != "cleaning"]
        if open_room_items and raised:
            problems.append(f"{len(open_room_items)} room item(s) still open")
        det = ", ".join(f"{e['data']['nose_id']}:{e['kind']}@{t - t_drop:.0f}s"
                        + (f"[{e['data'].get('ingredient')}]" if e['data'].get('ingredient') else "")
                        for t, e in raised) or "-"
        clr = ", ".join(f"{e['data']['nose_id']}@{t - t_remove:.0f}s" for t, e in clears if t > t_remove) or "-"
        ok = not problems
        rows.append((name, det, clr, "PASS" if ok else "FAIL: " + "; ".join(problems)))
        if not ok:
            failures.append(name)

    w1 = max(len(r[0]) for r in rows)
    w2 = max(len(r[1]) for r in rows)
    w3 = max(len(r[2]) for r in rows)
    print(f"calibrated: {calib}")
    print(f"{'case':<{w1}}  {'detections (since drop)':<{w2}}  {'clears (since removal)':<{w3}}  result")
    for r in rows:
        print(f"{r[0]:<{w1}}  {r[1]:<{w2}}  {r[2]:<{w3}}  {r[3]}")
    print("inference log (newest first):")
    for inf in room.snapshot()["inferences"][:6]:
        print("  ", inf["summary"])
    print(f"\n{len(rows) - len(failures)}/{len(rows)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
