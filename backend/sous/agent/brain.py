"""The agent: fuses orders + ears + nose into actions and one spoken voice.

Rules decide *what* to do (deterministic, demo-safe). The LLM decides *how to say it* and,
for the nose, helps label ambiguous signatures with context. If the LLM is slow or absent,
the rules text is spoken instead; nothing waits on it.

Speech is rate-limited: fire calls are coalesced so the voice is not a firehose during a rush,
and alerts always jump the queue.
"""
from __future__ import annotations

import asyncio
import itertools
import time
from typing import Awaitable, Callable, Optional

from collections import deque

from ..sim.menu_data import SUBSTITUTES, pretty
from ..sim.world import World
from ..senses.hearing import HearingClassifier
from ..senses.smell import SmellPipeline
from . import llm

STOCKOUT_HORIZON_MIN = 15.0     # sim minutes
MIN_HISTORY_MIN = 4.0           # don't forecast off the first couple of tickets
FIRE_SPEECH_GAP_S = 8.0
REORDER_SUPPLIER = "Paragon Foods"
SUB_DISCOUNT_PCT = 15
PUSH_DISCOUNT_PCT = 20


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


class Brain:
    def __init__(self, world: World, nose: SmellPipeline, ears: HearingClassifier,
                 emit_action: Callable[[dict], None], speak: Callable[[str], Awaitable[None]],
                 emit_event: Callable[[dict], None]):
        self.world, self.nose, self.ears = world, nose, ears
        self.emit_action, self.speak_cb, self.emit_event = emit_action, speak, emit_event
        self._seq = itertools.count(1)
        self.actions: list[dict] = []
        self.last_line = ""
        self.muted = False
        self._pending_fire: list[str] = []
        self._last_fire_speech = 0.0
        self._hidden_for: dict[str, set[str]] = {}       # ingredient -> menu ids we hid
        self._handled_anomaly: Optional[str] = None
        self._tasks: set[asyncio.Task] = set()
        self._cleaning_ignore_until = 0.0
        self._hearing_log: deque[dict] = deque(maxlen=12)

    # ------------------------------------------------------------------ plumbing
    def _bg(self, coro: Awaitable) -> None:
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    def act(self, type_: str, summary: str, by: str = "rules", **payload) -> dict:
        a = {"id": f"a{next(self._seq)}", "t": now_iso(), "type": type_, "summary": summary,
             "payload": payload, "by": by}
        self.actions.insert(0, a)
        del self.actions[30:]
        self.emit_action(a)
        return a

    async def say(self, rules_line: str, context: str = "", priority: bool = False) -> None:
        line, by = await llm.rewrite_line(rules_line, context) if context else (rules_line, "rules")
        self.last_line = line
        self.act("speak", line, by=by, priority=priority)
        if not self.muted:
            await self.speak_cb(line)

    def _ctx(self) -> str:
        w = self.world
        low = [f"{i.name} {i.on_hand:.0f}{i.unit} (~{i.minutes_to_stockout():.0f} min left)"
               for i in w.inventory.values() if i.minutes_to_stockout() and i.minutes_to_stockout() < 40]
        return (f"Sim time {w.sim_minutes:.0f} min after open, rush={'on' if w.rush else 'off'}, "
                f"{w.load} orders cooking, {len([o for o in w.orders if o.status in ('queued','fire')])} waiting. "
                f"Low stock: {', '.join(low) or 'none'}. Kitchen noise {self.ears.noise_db:.0f} dBFS, "
                f"stress {self.ears.stress:.1f}. Nose: {self.nose.status} at {self.nose.location}.")

    # ------------------------------------------------------------------ event hooks
    def on_world_event(self, ev: dict) -> None:
        if ev["kind"] == "fire":
            self._pending_fire.append(ev["data"]["order_id"])

    def on_hearing_event(self, ev: dict) -> None:
        w = self.world
        kind = ev["kind"]
        self._hearing_log.append(ev)
        if kind == "ticket_burst":
            o = w.spawn_heard_order()
            if o:
                items = ", ".join(f"{i['qty']}x {i['name']}" for i in o.items)
                self.act("fire_now" if o.fire_at <= w.sim_minutes + 0.5 else "speak",
                         f"Heard a ticket print: {o.id} ({o.channel}) added to the board", order_id=o.id)
                self._bg(self.say(f"Heard a ticket. {o.id} on the board, {items}." if len(o.items) == 1 else f"Heard a ticket. {o.id} on the board, {len(o.items)} items.", self._ctx()))
        elif kind == "fryer_alarm":
            fry = [o for o in w.orders if o.status == "cooking" and any("fryer" in w.menu[i["id"]].tags for i in o.items)]
            if fry:
                ids = ", ".join(o.id for o in fry[:2])
                self.act("speak", f"Fryer alarm matched to {ids}", order_ids=[o.id for o in fry])
                self._bg(self.say(f"Fries up for {ids}.", priority=True))
            else:
                # sad path: an alarm nobody is waiting for
                self.act("ask_human", "Fryer alarm with nothing on the fryer ticket", station="fry-station")
                self._bg(self.say("Fryer alarm and nothing's on the fryer ticket. Someone check station 2.",
                                  priority=True))
        elif kind == "door_chime":
            ready = [o for o in w.orders if o.status == "ready" and o.channel in ("doordash", "ubereats")]
            soon = [o for o in w.orders if o.status in ("cooking", "fire") and o.channel in ("doordash", "ubereats")]
            if ready:
                o = ready[0]
                w.pick_up(o)
                self.act("speak", f"Dasher at the door matched to {o.id}", order_id=o.id)
                self._bg(self.say(f"Dasher at the door for {o.id}. Bag's on the shelf, check the name.", priority=True))
            elif soon:
                o = min(soon, key=lambda x: x.fire_at + x.prep_minutes)
                mins = max(0.5, o.fire_at + o.prep_minutes + 0.5 - w.sim_minutes)
                self.act("speak", f"Dasher early for {o.id}", order_id=o.id, minutes=round(mins, 1))
                self._bg(self.say(f"Door chime. Nothing ready for pickup yet. {o.id} is about {mins:.0f} minutes out, "
                                  f"let the Dasher know.", priority=True))
            else:
                self._bg(self.say("Door chime. Nothing on the pickup shelf."))
        elif kind == "noise_spike":
            if self.ears.stress > 0.7:
                self._bg(self.say("It's loud. Call your orders back so nothing gets missed."))

    def on_smell_event(self, ev: dict) -> None:
        kind = ev["kind"]
        if kind in ("device_connected", "device_offline", "relocated"):
            return
        if kind == "voc_clear":
            self._handled_anomaly = None
            self._bg(self.say(f"Air's clear at the {self.nose.location.replace('-', ' ') if self.nose.location != 'walk-in' else 'walk-in'}."))
            return
        if self._handled_anomaly == ev["id"]:
            return
        self._handled_anomaly = ev["id"]
        self._bg(self._handle_anomaly(kind, ev))

    async def _handle_anomaly(self, kind: str, ev: dict) -> None:
        w, n = self.world, self.nose
        d = ev.get("data", {})
        perishable = w.most_perishable_in("walk-in")
        context = (
            f"VOC sensor at the {n.location}. Ratio {d.get('ratio')}x clean-air baseline, rising "
            f"{d.get('rate_per_s')}/s, temperature change {d.get('temp_delta_c')} C, humidity {n.rh}%. "
            f"Heuristic label: {kind} (confidence {d.get('confidence')}). Time: {w.sim_minutes:.0f} min after "
            f"open. In the walk-in the most perishable stock is {perishable.name if perishable else 'nothing'} "
            f"({perishable.days_in_stock if perishable else 0} days in). Recent kitchen sounds: "
            f"{', '.join(e['kind'] for e in list(self._recent_hearing())[-4:]) or 'none'}. {self._ctx()}")

        defaults = {
            "spoilage": {"kind": "spoilage", "action": "promote", "confidence": 0.7,
                         "line": (f"Nose says the {pretty(perishable.name) if perishable else 'produce'} in the walk-in is "
                                  f"turning. Pushing it today at {PUSH_DISCOUNT_PCT} percent off and skipping tomorrow's order.")},
            "burning": {"kind": "burning", "action": "alert", "confidence": 0.8,
                        "line": "Something's burning on the line. Check station 2 now."},
            "oil_degraded": {"kind": "oil_degraded", "action": "change_oil", "confidence": 0.65,
                             "line": "Fryer oil's past its life. Change it before the dinner rush. Oil's cheaper than a bad review."},
            "cleaning": {"kind": "cleaning", "action": "ignore", "confidence": 0.55,
                         "line": "Nose spiked in the walk-in, looks like cleaner. Ignoring it for two minutes."},
            "unknown": {"kind": "unknown", "action": "ask_human", "confidence": 0.3,
                        "line": f"Nose picked up something in the {n.location} I can't place. Can someone take a look?"},
        }[kind]
        decision, by = await llm.fuse_smell(context, defaults)
        action = decision.get("action", "ask_human")
        line = decision.get("line", defaults["line"])

        if action == "promote" and perishable:
            w.mark_turning(perishable.name)
            for m in w.items_using(perishable.name):
                if m.available:
                    w.set_discount(m.id, PUSH_DISCOUNT_PCT, f"{pretty(perishable.name)} is turning, moving it today")
            saved = perishable.on_hand * 1.9  # rough $/unit of produce that would otherwise be waste
            w.metrics["est_waste_saved_usd"] += saved
            self.act("menu_discount", f"Promoting {pretty(perishable.name)} dishes at {PUSH_DISCOUNT_PCT}% to move "
                     f"stock before it spoils", by=by, ingredient=perishable.name, pct=PUSH_DISCOUNT_PCT,
                     confidence=decision.get("confidence"))
            self.act("reorder_draft", f"Skip tomorrow's {pretty(perishable.name)} order, re-check freshness at close", by=by,
                     supplier=REORDER_SUPPLIER, ingredient=perishable.name, qty=0, unit=perishable.unit,
                     note="nose flagged spoilage")
        elif action == "alert":
            self.act("ask_human", "Burning detected on the line", by=by, station="line", severity="alert")
        elif action == "change_oil":
            w.mark_turning("fry_oil", "spoiled")
            self.act("ask_human", "Change fryer oil before service", by=by, station="fry-station")
            self.act("reorder_draft", "Fry oil: 1 x 20 L jug", by=by, supplier=REORDER_SUPPLIER,
                     ingredient="fry_oil", qty=20, unit="L", note="nose: oil degraded")
        elif action == "ignore":
            self._cleaning_ignore_until = time.monotonic() + 120
            self.act("speak", "Ignoring cleaning-product spike", by=by)
        else:
            self.act("ask_human", f"Unclassified VOC rise at the {n.location}, asking staff to check", by=by,
                     confidence=decision.get("confidence"))
        await self.say(line, priority=True)

    def _recent_hearing(self) -> list[dict]:
        return list(self._hearing_log)

    # ------------------------------------------------------------------ periodic decisions
    async def tick(self) -> None:
        await self._stockout_watch()
        await self._fire_calls()

    async def _stockout_watch(self) -> None:
        w = self.world
        for ing in w.inventory.values():
            if ing.name == "fry_oil":
                continue
            mts = ing.minutes_to_stockout()
            max_need = max((m.ingredients[ing.name] for m in w.items_using(ing.name)), default=0)
            forecast_low = (mts is not None and mts < STOCKOUT_HORIZON_MIN and w.sim_minutes >= MIN_HISTORY_MIN)
            low = forecast_low or ing.on_hand < max_need
            name = pretty(ing.name)
            hidden = self._hidden_for.get(ing.name, set())
            if low and not hidden:
                to_hide = [m for m in w.items_using(ing.name) if m.available]
                if not to_hide:
                    continue
                names = []
                subs = []
                for m in to_hide:
                    w.hide_item(m.id, f"{name} runs out in ~{mts:.0f} min" if forecast_low else f"out of {name}")
                    hidden.add(m.id)
                    names.append(m.name)
                    sub = SUBSTITUTES.get(m.id)
                    if sub and w.menu[sub].available and ing.name not in w.menu[sub].ingredients:
                        w.set_discount(sub, SUB_DISCOUNT_PCT, f"suggested instead of {m.name}", substitute_for=m.id)
                        subs.append(w.menu[sub].name)
                self._hidden_for[ing.name] = hidden
                qty = max(0, ing.par - ing.on_hand)
                self.act("menu_hide", f"Pulled {', '.join(names)} from DoorDash and Uber Eats: {name} "
                         f"{'runs out in ~%d min' % mts if forecast_low else 'is out'}",
                         ingredient=ing.name, items=[m.id for m in to_hide], minutes_to_stockout=mts)
                if subs:
                    self.act("substitute", f"Promoting {', '.join(dict.fromkeys(subs))} at {SUB_DISCOUNT_PCT}% off",
                             items=subs, pct=SUB_DISCOUNT_PCT)
                self.act("reorder_draft", f"{name}: {qty:.0f} {ing.unit} from {REORDER_SUPPLIER}",
                         supplier=REORDER_SUPPLIER, ingredient=ing.name, qty=round(qty), unit=ing.unit,
                         note="auto-drafted on predicted stockout; owner approves")
                when = f"in about {mts:.0f} minutes" if forecast_low else "now"
                line = (f"{name.capitalize()} runs out {when}. Pulling {' and '.join(names)} from DoorDash and "
                        f"Uber Eats now" + (f", promoting {subs[0]} at {SUB_DISCOUNT_PCT} percent off" if subs else "")
                        + f". Reorder draft for {qty:.0f} {ing.unit} is ready.")
                await self.say(line, self._ctx(), priority=True)
            elif hidden and not low and ing.on_hand >= ing.par * 0.5:
                # restocked (human pressed "we got more"): restore
                for mid in list(hidden):
                    w.restore_item(mid)
                self._hidden_for[ing.name] = set()
                self.act("menu_restore", f"{name} restocked, restored {', '.join(w.menu[m].name for m in hidden)}",
                         ingredient=ing.name, items=list(hidden))
                await self.say(f"{name.capitalize()} is back. Restoring the menu.", priority=True)

    async def _fire_calls(self) -> None:
        if not self._pending_fire:
            return
        # never more than one fire call per FIRE_SPEECH_GAP_S; whatever queued up gets one combined call
        if time.monotonic() - self._last_fire_speech < FIRE_SPEECH_GAP_S:
            return
        ids, self._pending_fire = self._pending_fire[:], []
        self._last_fire_speech = time.monotonic()
        w = self.world
        orders = [o for o in w.orders if o.id in ids]
        if not orders:
            return
        if len(orders) == 1:
            o = orders[0]
            items = ", ".join(f"{i['qty']}x {i['name']}" if i['qty'] > 1 else i['name'] for i in o.items)
            eta = ""
            if o.dasher_eta_min is not None:
                eta = f", Dasher {max(0, o.placed_at + o.dasher_eta_min - w.sim_minutes):.0f} minutes out"
            line = f"Fire {o.id}, {items}{eta}."
        elif len(orders) <= 3:
            line = "Fire " + ", ".join(o.id for o in orders[:-1]) + f" and {orders[-1].id}."
        else:
            line = f"Fire {orders[0].id}, {orders[1].id}, {orders[2].id} and {len(orders) - 3} more. Call them back."
        self.act("fire_now", line, order_ids=[o.id for o in orders])
        await self.say(line)

    def human_restore(self, mid: str) -> None:
        """Staff pressed 'We got more' on an item: treat it as a delivery of every scarce ingredient in it."""
        w = self.world
        for ing in w.menu[mid].ingredients:
            if mid in self._hidden_for.get(ing, set()) or w.inventory[ing].on_hand < w.inventory[ing].par * 0.3:
                w.restock(ing)
        w.restore_item(mid)
