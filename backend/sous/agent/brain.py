"""The agent: turns sense events and order state into prioritised action items, a few automatic
storefront actions, and one calm voice.

Design rules:
* Every signal becomes at most one item. Repeats update a count instead of adding noise.
* Rules decide. The LLM (optional) only phrases lines and helps label ambiguous smells.
* The voice speaks "now" items and the storefront moves; everything else is read, not heard.
* Items auto-resolve when the world shows they are handled (Dasher left, air cleared, stock back).
* Nothing here blocks on a network call; LLM use has a hard timeout and a rules fallback.
"""
from __future__ import annotations

import asyncio
import itertools
import os
import time
from collections import deque
from typing import Awaitable, Callable, Optional

from ..sim.menu_data import SUBSTITUTES, pretty
from ..sim.world import World
from .items import ItemStore
from . import tts

STOCKOUT_HORIZON_MIN = 18.0
MIN_HISTORY_MIN = 4.0
REORDER_SUPPLIER = "Paragon Foods"
SUB_DISCOUNT_PCT = 15
PUSH_DISCOUNT_PCT = 20
SPEAK_FIRE_CALLS = os.environ.get("SOUS_SPEAK_FIRE_CALLS", "auto")
FIRE_SPEECH_GAP_S = 8.0


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def spoken_loc(loc: str) -> str:
    return loc if loc == "walk-in" else loc.replace("-", " ")


class Brain:
    def __init__(self, world: World, nose, ears, items: ItemStore,
                 emit_action: Callable[[dict], None], speak: Callable[[str], Awaitable[None]],
                 emit_event: Callable[[dict], None]):
        self.world, self.nose, self.ears, self.items = world, nose, ears, items
        self.emit_action, self.speak_cb, self.emit_event = emit_action, speak, emit_event
        self._seq = itertools.count(1)
        self.actions: list[dict] = []
        self.last_line = ""
        self.muted = False
        self._pending_fire: list[str] = []
        self._last_fire_speech = 0.0
        self._hidden_for: dict[str, set[str]] = {}
        self._tasks: set[asyncio.Task] = set()
        self._hearing_log: deque[dict] = deque(maxlen=20)
        self._last_speech: dict[str, float] = {}
        self._handled_anomaly: Optional[str] = None
        self._pushed_for: dict[str, list[str]] = {}     # ingredient -> menu ids discounted because it was turning

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

    async def say(self, line: str, key: Optional[str] = None, min_gap_s: float = 0.0) -> None:
        if key and time.monotonic() - self._last_speech.get(key, -1e9) < min_gap_s:
            return
        if key:
            self._last_speech[key] = time.monotonic()
        self.last_line = line
        self.act("speak", line)
        if not self.muted:
            await self.speak_cb(line)

    def _item(self, **kw) -> dict:
        """Add an item; speak its line if it has one (new items always, repeats only after speak_gap)."""
        speak = kw.pop("speak", None)
        speak_key = kw.pop("speak_key", None)
        speak_gap = kw.pop("speak_gap", 0.0)
        it, is_new = self.items.add(**kw)
        if speak and (is_new or speak_key):
            self._bg(self.say(speak, key=speak_key or it["id"], min_gap_s=speak_gap))
        return it

    # ------------------------------------------------------------------ orders
    def on_world_event(self, ev: dict) -> None:
        if ev["kind"] == "fire":
            self._pending_fire.append(ev["data"]["order_id"])
        elif ev["kind"] == "picked_up":
            oid = ev["data"]["order_id"]
            self.items.resolve(lambda i: i["sense"] == "hearing" and i["evidence"].get("order_id") == oid)

    # ------------------------------------------------------------------ hearing
    def on_hearing_event(self, ev: dict) -> None:
        w = self.world
        kind, d = ev["kind"], ev.get("data", {})
        loc = d.get("location", "kitchen")
        if kind in ("mic_online", "mic_offline", "taught"):
            return
        self._hearing_log.append(ev)
        evidence = {"mic": d.get("mic"), "location": loc, "how": d.get("how"), "confidence": d.get("confidence"),
                    "heard_as": (d.get("top") or [[None]])[0][0], "db": d.get("db")}

        if kind == "ticket_burst":
            o = w.spawn_heard_order()
            if o:
                burst = d.get("burst_30s", 1)
                self._item(title=f"{burst} ticket{'s' if burst > 1 else ''} printed off the tablet",
                           detail=f"Heard the POS printer at the {loc}; {o.id} added to the board so it is fired on time.",
                           urgency="next", sense="hearing", kind=kind, key="tickets_offtablet", location=loc,
                           auto={"type": "board", "summary": f"{o.id} added to the board"},
                           evidence=dict(evidence, order_id=o.id),
                           speak="Heard a ticket print. Adding it to the board.", speak_key="ticket", speak_gap=45.0,
                           expires_s=90.0)
        elif kind == "fryer_alarm":
            fry = [o for o in w.orders if o.status == "cooking" and any("fryer" in w.menu[i["id"]].tags for i in o.items)]
            if fry:
                o = fry[0]
                self._item(title=f"Fries up: plate them for {o.id}",
                           detail=f"Fryer alarm at the {loc} matches {o.id}, which is cooking fries.",
                           urgency="now", sense="hearing", kind=kind, key=f"fries_{o.id}", location=loc,
                           evidence=dict(evidence, order_id=o.id), speak="Fries up. Match them to the ticket.",
                           expires_s=90.0)
            else:
                self._item(title="Check station 2: fryer alarm with no fryer ticket",
                           detail="An alarm is going off and nothing on the board is cooking fries. Someone left a basket in.",
                           urgency="now", sense="hearing", kind=kind, key="fryer_orphan", location=loc,
                           evidence=evidence, speak="Fryer alarm and nothing's on the fryer ticket. Someone check station 2.",
                           speak_key="fryer_orphan", speak_gap=20.0, expires_s=120.0)
        elif kind == "door_chime":
            ready = [o for o in w.orders if o.status == "ready" and o.channel in ("doordash", "ubereats")]
            soon = [o for o in w.orders if o.status in ("cooking", "fire") and o.channel in ("doordash", "ubereats")]
            if ready:
                o = ready[0]
                self._item(title=f"Hand {o.id} to the Dasher at the door",
                           detail="Door chime while a delivery order is on the shelf. Check the name on the bag.",
                           urgency="now", sense="hearing", kind=kind, key=f"handoff_{o.id}", location=loc,
                           evidence=dict(evidence, order_id=o.id),
                           speak="Dasher at the door. Bag's on the shelf, check the name.", expires_s=90.0)
                asyncio.get_event_loop().call_later(6.0, lambda: w.pick_up(o))
            elif soon:
                o = min(soon, key=lambda x: x.fire_at + x.prep_minutes)
                mins = max(0.5, o.fire_at + o.prep_minutes + 0.5 - w.sim_minutes)
                self._item(title=f"Dasher waiting: tell them {o.id} is ~{mins:.0f} min out",
                           detail="Door chime before the order is ready. A quick word keeps the Dasher from leaving.",
                           urgency="now", sense="hearing", kind=kind, key=f"wait_{o.id}", location=loc,
                           evidence=dict(evidence, order_id=o.id, minutes=round(mins, 1)),
                           speak="Door chime. Nothing ready for pickup yet, let the Dasher know.", expires_s=120.0)
            else:
                self._item(title="Someone at the front door",
                           detail="Door chime; no delivery order is due. Probably a walk-in.",
                           urgency="next", sense="hearing", kind=kind, key="door", location=loc, evidence=evidence,
                           speak="Door chime. Nothing on the pickup shelf.", speak_key="door_plain", speak_gap=30.0,
                           expires_s=60.0)
        elif kind == "phone_ring":
            self._item(title="Phone ringing: pick up, likely a phone order",
                       detail=f"Heard the landline at the {loc}.", urgency="now", sense="hearing", kind=kind,
                       key="phone", location=loc, evidence=evidence, speak="Phone's ringing. Someone grab it.",
                       speak_key="phone", speak_gap=20.0, expires_s=60.0)
        elif kind == "clatter":
            burst = d.get("burst_30s", 1)
            self._item(title=f"Something dropped at the {loc}: check for breakage",
                       detail="Loud clatter picked up by the mic." + (" Twice in 30 seconds." if burst > 1 else ""),
                       urgency="next", sense="hearing", kind=kind, key=f"clatter_{loc}", location=loc,
                       evidence=evidence, speak=("Lot of noise out there. Everyone okay?" if burst > 1 else None),
                       speak_key="clatter", speak_gap=60.0, expires_s=120.0)

    # ------------------------------------------------------------------ smell
    def on_smell_event(self, ev: dict) -> None:
        kind, d = ev["kind"], ev.get("data", {})
        loc = d.get("location") or getattr(self.nose, "location", "walk-in")
        if kind in ("device_connected", "device_offline", "relocated"):
            return
        if kind == "voc_clear":
            if d.get("source") == "room":
                self._room_clear(d, loc)
                return
            closed = self.items.resolve(lambda i: i["sense"] == "smell" and i.get("location") == loc
                                        and i["evidence"].get("source") != "room")
            if closed:
                self._bg(self.say(f"Air's clear at the {spoken_loc(loc)}."))
            return
        if self._handled_anomaly == ev.get("id"):
            return
        self._handled_anomaly = ev.get("id")
        self._bg(self._handle_anomaly(kind, d, loc))

    def room_reset(self) -> None:
        """Scent room cleared (or the server restarted, so its air is gone): close every room-sourced smell
        item and put stock the room flagged back to fresh, ending its push discounts. Quiet: no voice."""
        closed = self.items.resolve(lambda i: i["sense"] == "smell" and i["evidence"].get("source") == "room")
        w = self.world
        for ing in {i["evidence"].get("ingredient") for i in closed} | set(self._pushed_for):
            inv = w.inventory.get(ing or "")
            if inv is None:
                continue
            if inv.freshness in ("turning", "watch"):
                inv.freshness = "fresh"
            for mid in self._pushed_for.pop(inv.name, []):
                m = w.menu.get(mid)
                if m is not None and m.discount_pct == PUSH_DISCOUNT_PCT and m.substitute_for is None:
                    w.set_discount(mid, 0, None)

    def _room_clear(self, d: dict, loc: str) -> None:
        """A scent-room nose cleared. Resolve only that plume's items (same ingredient, or same kind at the
        same location for non-ingredient smells); if another nose still smells it, wait for that one.
        A turning/watch ingredient whose smell is gone goes back to fresh and loses its push discount."""
        if d.get("still_active"):
            return
        ing, prev = d.get("ingredient"), d.get("previous")
        if ing:
            pred = lambda i: (i["sense"] == "smell" and i["evidence"].get("source") == "room"
                              and i["evidence"].get("ingredient") == ing)
        else:
            pred = lambda i: (i["sense"] == "smell" and i["evidence"].get("source") == "room"
                              and i["kind"] == prev and i.get("location") == loc)
        closed = self.items.resolve(pred)
        w = self.world
        inv = w.inventory.get(ing or "")
        if inv is not None and inv.freshness in ("turning", "watch"):
            was = inv.freshness
            inv.freshness = "fresh"
            undone = []
            for mid in self._pushed_for.pop(inv.name, []):
                m = w.menu.get(mid)
                if m is not None and m.discount_pct == PUSH_DISCOUNT_PCT and m.substitute_for is None:
                    w.set_discount(mid, 0, None)
                    undone.append(m.name)
            name = pretty(inv.name)
            self.act("freshness_restored",
                     f"{name.capitalize()} smells fine again: back to fresh"
                     + (f", ended the push on {', '.join(undone)}" if undone else ""),
                     ingredient=inv.name, was=was, items=undone, nose_id=d.get("nose_id"))
            self._bg(self.say(f"Air's clear by the {name}. Marking it fresh"
                              + (" and ending the discount." if undone else ".")))
        elif closed:
            self._bg(self.say(f"Air's clear at the {spoken_loc(loc)}."))

    async def _handle_anomaly(self, kind: str, d: dict, loc: str) -> None:
        w = self.world
        room = d.get("source") == "room"
        evidence = {"location": loc, "confidence": d.get("confidence"), "probs": d.get("probs"),
                    "fingerprint": d.get("fingerprint"), "single_channel": d.get("single_channel")}
        if room:
            evidence.update(source="room", nose_id=d.get("nose_id"), ingredient=d.get("ingredient"),
                            est_xy=d.get("est_xy"))
        inferred = w.inventory.get(d.get("ingredient") or "")
        # room events key per kind+ingredient (two walk-in noses on one plume update one item)
        rkey = (lambda base: f"{base}:{inferred.name}" if (room and inferred) else
                (f"{base}:{loc}" if room else base))
        if room and not inferred and kind in ("spoilage_produce", "spoilage_protein"):
            # a room plume away from any matching shelf: say where, blame nothing
            where = (d.get("zone_label") or spoken_loc(loc)).lower()
            what = "Produce turning" if kind == "spoilage_produce" else "Spoiling protein"
            self._item(title=f"{what} smell near the {where}: nothing like that is shelved there, take a look",
                       detail="The noses place the plume away from any stocked bin of that kind, so Sous is not "
                              "flagging an ingredient. Find the source (a dropped tray, the bin, a delivery).",
                       urgency="today", sense="smell", kind=kind, key=rkey(kind), location=loc, evidence=evidence,
                       speak=f"Nose smells {what.lower()} near the {where}. Someone take a look.")
            return
        perishable = inferred or w.most_perishable_in("walk-in")
        how = (f" The plume is nearest the {pretty(inferred.name)} bin (inferred from the noses' readings and "
               f"where stock is shelved).") if inferred else ""
        if kind == "spoilage_produce" and perishable:
            name = pretty(perishable.name)
            already = room and perishable.freshness == "turning"
            if not already:
                w.mark_turning(perishable.name)
                pushed = []
                for m in w.items_using(perishable.name):
                    if m.available:
                        w.set_discount(m.id, PUSH_DISCOUNT_PCT, f"{name} is turning, moving it today")
                        pushed.append(m.id)
                self._pushed_for.setdefault(perishable.name, []).extend(pushed)
                w.metrics["est_waste_saved_usd"] += perishable.on_hand * 1.9
                if pushed:
                    self.act("menu_discount", f"Promoting {name} dishes at {PUSH_DISCOUNT_PCT}% to move stock",
                             ingredient=perishable.name, pct=PUSH_DISCOUNT_PCT, items=pushed)
                self.act("reorder_draft", f"Skip tomorrow's {name} order", supplier=REORDER_SUPPLIER,
                         ingredient=perishable.name, qty=0, unit=perishable.unit, note="nose: produce turning")
            self._item(title=f"{name.capitalize()} is turning: use it today",
                       detail=f"Fermentation signature in the walk-in.{how} Sous discounted every {name} dish "
                              f"{PUSH_DISCOUNT_PCT}% and drafted a zero reorder for tomorrow. Check the tray at close.",
                       urgency="today", sense="smell", kind=kind, key=rkey("spoilage_produce"), location=loc,
                       auto={"type": "menu_discount",
                             "summary": f"{PUSH_DISCOUNT_PCT}% off {name} dishes, reorder skipped"},
                       evidence=evidence,
                       speak=f"Nose says the {name} in the walk-in is turning. Pushing it today at "
                             f"{PUSH_DISCOUNT_PCT} percent off and skipping tomorrow's order.")
        elif kind == "spoilage_protein":
            protein = inferred or next((i for i in w.inventory.values() if i.name in ("carnitas", "chicken")), None)
            if protein and (not room or protein.freshness == "fresh"):
                w.mark_turning(protein.name, "watch")
            what = pretty(protein.name) if protein else "meat"
            self._item(title=f"Protein in the walk-in smells off: check the {what} before service",
                       detail=f"Amine signature (spoiling protein).{how} Sous does not auto-act on food safety; a person decides.",
                       urgency="today", sense="smell", kind=kind, key=rkey("spoilage_protein"), location=loc,
                       evidence=evidence,
                       speak=(f"Nose is picking up spoiling protein in the walk-in, near the {what}. "
                              f"Someone check it before service." if inferred else
                              "Nose is picking up spoiling protein in the walk-in. Someone check the meat before service."))
        elif kind == "burning":
            self._item(title="Something is burning on the line: check station 2 now",
                       detail="Fast, large VOC rise with a temperature jump. Not a cleaning product.",
                       urgency="now", sense="smell", kind=kind, key=rkey("burning"), location=loc, evidence=evidence,
                       speak="Something's burning on the line. Check station 2 now.", expires_s=240.0)
        elif kind == "oil_degraded":
            w.mark_turning("fry_oil", "spoiled")
            self.act("reorder_draft", "Fry oil: 1 x 20 L jug", supplier=REORDER_SUPPLIER, ingredient="fry_oil", qty=20,
                     unit="L", note="nose: oil degraded")
            self._item(title="Change the fryer oil before the dinner rush",
                       detail="Slow aldehyde creep at the fry station: the oil is past its life. Reorder drafted.",
                       urgency="next", sense="smell", kind=kind, key=rkey("oil"), location=loc,
                       auto={"type": "reorder_draft", "summary": "20 L fry oil drafted"}, evidence=evidence,
                       speak="Fryer oil's past its life. Change it before the dinner rush. Oil's cheaper than a bad review.")
        elif kind in ("cleaning", "door_open"):
            self._item(title=("Cleaning-product spike in the walk-in, ignoring" if kind == "cleaning"
                              else "Walk-in door left open a while"),
                       detail=("Oxidising signature with a humidity jump; not food. No action." if kind == "cleaning"
                               else "Humidity and temperature transient; nothing to act on unless it keeps happening."),
                       urgency="later", sense="smell", kind=kind, key=rkey(kind), location=loc, evidence=evidence,
                       speak=("Nose spiked in the walk-in, looks like cleaner. Ignoring it for two minutes."
                              if kind == "cleaning" else None), expires_s=120.0)
        else:
            self._item(title=f"Unidentified smell at the {loc}: take a look",
                       detail="The nose sees a rise it cannot label with confidence, so it asks instead of acting.",
                       urgency="next", sense="smell", kind="unknown", key=f"unknown_{loc}", location=loc,
                       evidence=evidence,
                       speak=f"Nose picked up something in the {spoken_loc(loc)} I can't place. Can someone take a look?")

    # ------------------------------------------------------------------ periodic
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
            forecast_low = mts is not None and mts < STOCKOUT_HORIZON_MIN and w.sim_minutes >= MIN_HISTORY_MIN
            low = forecast_low or ing.on_hand < max_need
            name = pretty(ing.name)
            hidden = self._hidden_for.get(ing.name, set())
            if low and not hidden:
                to_hide = [m for m in w.items_using(ing.name) if m.available]
                if not to_hide:
                    continue
                names, subs = [], []
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
                         supplier=REORDER_SUPPLIER, ingredient=ing.name, qty=round(qty), unit=ing.unit)
                spoken = [n.replace("&", "and").replace(" (3)", "") for n in names]
                pulled = spoken[0] if len(spoken) == 1 else ", ".join(spoken[:-1]) + " and " + spoken[-1]
                verb = "is about to run out" if forecast_low else "is out"
                line = (f"{name.capitalize()} {verb}. Pulling {pulled} from DoorDash and Uber Eats now"
                        + (f", promoting {subs[0].replace('&', 'and')} at {SUB_DISCOUNT_PCT} percent off" if subs else "")
                        + ". Reorder draft is ready.")
                self._item(title=f"{name.capitalize()} {'runs out in ~%d min' % mts if forecast_low else 'is out'}: "
                                 f"approve the reorder ({qty:.0f} {ing.unit})",
                           detail=f"Sous already pulled {', '.join(names)} from the delivery apps"
                                  + (f" and is promoting {subs[0]} at {SUB_DISCOUNT_PCT}% off" if subs else "")
                                  + f". Reorder from {REORDER_SUPPLIER} is drafted; press 'We got more' when it lands.",
                           urgency="next" if forecast_low else "now", sense="orders", kind="stockout",
                           key=f"stockout_{ing.name}",
                           auto={"type": "menu_hide",
                                 "summary": f"{len(names)} dishes pulled, substitute promoted, reorder drafted"},
                           evidence={"ingredient": ing.name, "minutes_to_stockout": mts, "on_hand": ing.on_hand,
                                     "burn_rate_per_min": ing.burn_rate_per_min}, speak=line, expires_s=3600.0)
            elif hidden and not low and ing.on_hand >= ing.par * 0.5:
                for mid in list(hidden):
                    w.restore_item(mid)
                self._hidden_for[ing.name] = set()
                self.act("menu_restore", f"{name} restocked, restored {', '.join(w.menu[m].name for m in hidden)}",
                         ingredient=ing.name, items=list(hidden))
                self.items.resolve(lambda i: i.get("key") == f"stockout_{ing.name}")
                await self.say(f"{name.capitalize()} is back. Restoring the menu.")

    async def _fire_calls(self) -> None:
        if not self._pending_fire or time.monotonic() - self._last_fire_speech < FIRE_SPEECH_GAP_S:
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
            eta = (f", Dasher {max(0, o.placed_at + o.dasher_eta_min - w.sim_minutes):.0f} minutes out"
                   if o.dasher_eta_min is not None else "")
            line = f"Fire {o.id}, {items}{eta}."
        elif len(orders) <= 3:
            line = "Fire " + ", ".join(o.id for o in orders[:-1]) + f" and {orders[-1].id}."
        else:
            line = f"Fire {orders[0].id}, {orders[1].id}, {orders[2].id} and {len(orders) - 3} more. Call them back."
        self.act("fire_now", line, order_ids=[o.id for o in orders])
        speak = SPEAK_FIRE_CALLS == "1" or (SPEAK_FIRE_CALLS == "auto" and tts.PROVIDER == "elevenlabs")
        if speak:
            await self.say(line)
        else:
            self.last_line = line

    def human_restore(self, mid: str) -> None:
        w = self.world
        for ing in w.menu[mid].ingredients:
            if mid in self._hidden_for.get(ing, set()) or w.inventory[ing].on_hand < w.inventory[ing].par * 0.3:
                w.restock(ing)
        w.restore_item(mid)
