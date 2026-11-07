"""The simulated restaurant: clock, multi-channel order stream, recipe-level inventory, storefront menu.

Everything here is deterministic given the RNG seed except for the speed knob. The agent
(see ``sous.agent.brain``) only *reads* this state and *acts* through the public methods
(``hide_item``, ``restore_item``, ``set_discount``, ``mark_turning``, ``spawn_heard_order``).

Time: 1 real second == 0.25 simulated minutes at speed 1x, so a 6-minute prep item cooks
in 24 real seconds. ``speed`` multiplies that.
"""
from __future__ import annotations

import itertools
import math
import random
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from .menu_data import (CHANNEL_PREFIX, EMOJI, INGREDIENTS, MENU, POPULARITY,
                        REFUND_COST_PER_INCIDENT_USD, SUBSTITUTES, pretty)

SIM_MIN_PER_REAL_S = 0.25
CHANNEL_WEIGHTS = {"doordash": 0.45, "ubereats": 0.20, "phone": 0.10, "walkin": 0.25}
ARRIVALS_PER_SIM_MIN = {"normal": 0.4, "rush": 1.0}
FIRE_WINDOW_MIN = 1.5          # how long a ticket sits in "fire" before the line starts cooking it
PERISHABILITY = {"avocado": 1.0, "carnitas": 0.9, "chicken": 0.8, "tomato": 0.7, "eggs": 0.3,
                 "cheese": 0.2, "horchata": 0.5}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


@dataclass
class Order:
    id: str
    channel: str
    items: list[dict]
    placed_at: float
    promised_at: float
    fire_at: float
    prep_minutes: float
    status: str = "queued"
    dasher_eta_min: Optional[float] = None
    ready_at: Optional[float] = None
    picked_up_at: Optional[float] = None
    heard: bool = False  # created from a ticket-printer burst the ears detected

    def to_dict(self, sim_now: float) -> dict:
        d = {
            "id": self.id, "channel": self.channel, "items": self.items,
            "placed_at": round(self.placed_at, 2), "promised_at": round(self.promised_at, 2),
            "fire_at": round(self.fire_at, 2), "prep_minutes": self.prep_minutes,
            "status": self.status, "heard": self.heard,
            "dasher_eta_min": None if self.dasher_eta_min is None
            else round(max(0.0, self.placed_at + self.dasher_eta_min - sim_now), 1),
        }
        projected_ready = (self.ready_at if self.ready_at is not None
                           else max(sim_now, self.fire_at) + self.prep_minutes)
        margin = self.promised_at - projected_ready
        d["late_risk"] = "low" if margin >= 1.5 else ("med" if margin >= -0.5 else "high")
        return d


@dataclass
class Ingredient:
    name: str
    unit: str
    on_hand: float
    par: float
    location: str
    days_in_stock: float
    burn_rate_per_min: float = 0.0
    freshness: str = "fresh"
    consumed_total: float = 0.0

    def minutes_to_stockout(self) -> Optional[float]:
        if self.burn_rate_per_min <= 1e-6:
            return None
        return self.on_hand / self.burn_rate_per_min

    def to_dict(self) -> dict:
        mts = self.minutes_to_stockout()
        return {
            "name": self.name, "label": pretty(self.name), "unit": self.unit, "on_hand": round(self.on_hand, 1),
            "par": self.par, "burn_rate_per_min": round(self.burn_rate_per_min, 3),
            "minutes_to_stockout": None if mts is None else round(mts, 1),
            "freshness": self.freshness, "days_in_stock": self.days_in_stock,
            "location": self.location,
        }


@dataclass
class MenuItem:
    id: str
    name: str
    price: float
    ingredients: dict
    tags: list[str]
    prep_minutes: float
    available: bool = True
    discount_pct: int = 0
    reason: Optional[str] = None
    substitute_for: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name, "price": self.price, "available": self.available,
            "discount_pct": self.discount_pct, "reason": self.reason,
            "substitute_for": self.substitute_for, "emoji": EMOJI.get(self.id, "🍽️"),
            "ingredients": [{"name": k, "qty": v, "label": pretty(k)} for k, v in self.ingredients.items()],
            "tags": self.tags,
        }


class World:
    def __init__(self, seed: int = 7, on_event: Optional[Callable[[dict], None]] = None):
        self.rng = random.Random(seed)
        self.on_event = on_event or (lambda e: None)
        self.reset(seed)

    # ------------------------------------------------------------------ lifecycle
    def reset(self, seed: int = 7) -> None:
        self.rng = random.Random(seed)
        self.sim_minutes = 0.0
        self.speed = 1.0
        self.rush = False
        self.orders: list[Order] = []
        self._order_counter = {c: itertools.count(100 if c == "doordash" else 1) for c in CHANNEL_WEIGHTS}
        self._next_arrival = self._draw_interarrival()
        self.inventory: dict[str, Ingredient] = {
            n: Ingredient(n, u, oh, par, loc, days) for n, (u, oh, par, loc, days) in INGREDIENTS.items()
        }
        self.menu: dict[str, MenuItem] = {
            m["id"]: MenuItem(m["id"], m["name"], m["price"], dict(m["ingredients"]), list(m["tags"]),
                              m["prep_minutes"]) for m in MENU
        }
        self.metrics = {"orders_served": 0, "stockouts_prevented": 0,
                        "est_refunds_avoided_usd": 0.0, "est_waste_saved_usd": 0.0}
        self._consumption_window: list[tuple[float, str, float]] = []  # (sim_t, ingredient, qty)
        self._event_seq = itertools.count(1)
        self.load = 0  # number of orders currently cooking

    def _emit(self, sense: str, kind: str, label: str, detail: str = "", severity: str = "info", **data) -> dict:
        ev = {"id": f"e{next(self._event_seq)}", "t": now_iso(), "sense": sense, "kind": kind,
              "label": label, "detail": detail, "severity": severity, "data": data}
        self.on_event(ev)
        return ev

    # ------------------------------------------------------------------ orders
    def _draw_interarrival(self) -> float:
        rate = ARRIVALS_PER_SIM_MIN["rush" if self.rush else "normal"]
        return self.rng.expovariate(rate)

    def _pick_items(self, channel: str, allow_unavailable: bool = False) -> tuple[list[dict], list[str]]:
        """Returns (items, suppressed) where suppressed are items the customer *wanted*
        but could not order because the storefront hid them. We count those as refunds avoided."""
        weights = POPULARITY[channel]
        n_items = self.rng.choices([1, 2, 3], weights=[0.5, 0.35, 0.15])[0]
        items: dict[str, int] = {}
        suppressed: list[str] = []
        for _ in range(n_items):
            mid = self.rng.choices(list(weights), weights=list(weights.values()))[0]
            if not self.menu[mid].available and not allow_unavailable:
                suppressed.append(mid)
                # the customer picks something else: prefer the promoted substitute
                sub = SUBSTITUTES.get(mid)
                if sub and self.menu[sub].available and self.rng.random() < 0.7:
                    mid = sub
                else:
                    continue
            items[mid] = items.get(mid, 0) + 1
        return [{"id": k, "name": self.menu[k].name, "qty": v} for k, v in items.items()], suppressed

    def _new_order(self, channel: str, items: list[dict], heard: bool = False) -> Optional[Order]:
        if not items:
            return None
        prep = max(self.menu[i["id"]].prep_minutes for i in items) + 0.5 * (len(items) - 1)
        if channel in ("doordash", "ubereats"):
            eta = self.rng.uniform(7, 16)
            promised = self.sim_minutes + eta
        elif channel == "phone":
            eta = None
            promised = self.sim_minutes + self.rng.uniform(12, 18)
        else:
            eta = None
            promised = self.sim_minutes + prep + 2
        # Just-in-time fire: food ready ~1 minute before the handoff, never before placement.
        fire_at = max(self.sim_minutes, promised - prep - FIRE_WINDOW_MIN - 1.0)
        oid = f"{CHANNEL_PREFIX[channel]}-{next(self._order_counter[channel])}"
        o = Order(oid, channel, items, self.sim_minutes, promised, fire_at, prep, dasher_eta_min=eta, heard=heard)
        self.orders.insert(0, o)
        self._emit("orders", "placed", f"{oid} placed", ", ".join(f"{i['qty']}x {i['name']}" for i in items),
                   order_id=oid, channel=channel, heard=heard)
        return o

    def spawn_heard_order(self) -> Optional[Order]:
        """The ears heard the POS ticket printer: an order exists that no tablet integration sees."""
        channel = self.rng.choices(["phone", "walkin"], weights=[0.4, 0.6])[0]
        items, _ = self._pick_items(channel)
        return self._new_order(channel, items, heard=True)

    def _arrivals(self) -> None:
        while self._next_arrival <= 0:
            channel = self.rng.choices(list(CHANNEL_WEIGHTS), weights=list(CHANNEL_WEIGHTS.values()))[0]
            items, suppressed = self._pick_items(channel)
            for mid in suppressed:
                self.metrics["est_refunds_avoided_usd"] += REFUND_COST_PER_INCIDENT_USD
                self._emit("orders", "suppressed", f"Avoided a refund on {self.menu[mid].name}",
                           f"A {channel} customer tried to order it; storefront already hid it.", item=mid)
            self._new_order(channel, items)
            self._next_arrival += self._draw_interarrival()

    def _consume(self, order: Order) -> None:
        for it in order.items:
            for ing, qty in self.menu[it["id"]].ingredients.items():
                q = qty * it["qty"]
                inv = self.inventory[ing]
                inv.on_hand = max(0.0, inv.on_hand - q)
                inv.consumed_total += q
                self._consumption_window.append((self.sim_minutes, ing, q))

    def _update_burn_rates(self, dt: float) -> None:
        """Consumption rate per ingredient: a 10-sim-minute trailing window, smoothed with a
        time-based EMA (tau 2 sim-min) so one big ticket does not whipsaw the forecast and a
        quiet minute does not erase it."""
        horizon = 10.0  # sim minutes
        self._consumption_window = [c for c in self._consumption_window if self.sim_minutes - c[0] <= horizon]
        totals: dict[str, float] = {}
        for _, ing, q in self._consumption_window:
            totals[ing] = totals.get(ing, 0.0) + q
        window = min(horizon, max(self.sim_minutes, 2.0))
        alpha = 1 - math.exp(-dt / 2.0)
        for ing, inv in self.inventory.items():
            inst = totals.get(ing, 0.0) / window
            inv.burn_rate_per_min += alpha * (inst - inv.burn_rate_per_min)
            if inv.burn_rate_per_min < 1e-4:
                inv.burn_rate_per_min = 0.0

    def _progress_orders(self) -> None:
        cooking = 0
        for o in self.orders:
            if o.status == "queued" and self.sim_minutes >= o.fire_at:
                o.status = "fire"
                self._emit("orders", "fire", f"Fire {o.id}", ", ".join(i["name"] for i in o.items), order_id=o.id)
            if o.status == "fire" and self.sim_minutes >= o.fire_at + FIRE_WINDOW_MIN:
                o.status = "cooking"
                self._consume(o)
            if o.status == "cooking":
                cooking += 1
                # kitchen load slows everything a little, capped so a rush degrades instead of stalling
                eff = o.prep_minutes * min(1.35, 1 + 0.06 * max(0, self.load - 4))
                if self.sim_minutes >= o.fire_at + FIRE_WINDOW_MIN + eff:
                    o.status = "ready"
                    o.ready_at = self.sim_minutes
                    self._emit("orders", "ready", f"{o.id} ready", severity="info", order_id=o.id)
            if o.status == "ready":
                handoff = (o.placed_at + o.dasher_eta_min) if o.dasher_eta_min else o.ready_at + 1.0
                if self.sim_minutes >= handoff:
                    self.pick_up(o)
        self.load = cooking
        # keep the board tidy
        self.orders = [o for o in self.orders if o.status != "picked_up"
                       or (self.sim_minutes - (o.picked_up_at or 0)) < 3.0][:24]

    def pick_up(self, o: Order) -> None:
        if o.status == "picked_up":
            return
        o.status = "picked_up"
        o.picked_up_at = self.sim_minutes
        self.metrics["orders_served"] += 1
        self._emit("orders", "picked_up", f"{o.id} handed off", order_id=o.id)

    # ------------------------------------------------------------------ storefront actions
    def items_using(self, ingredient: str) -> list[MenuItem]:
        return [m for m in self.menu.values() if ingredient in m.ingredients]

    def hide_item(self, mid: str, reason: str) -> bool:
        m = self.menu[mid]
        if not m.available:
            return False
        m.available, m.reason = False, reason
        m.discount_pct, m.substitute_for = 0, None
        self.metrics["stockouts_prevented"] += 1
        return True

    def restore_item(self, mid: str) -> bool:
        m = self.menu[mid]
        changed = not m.available or m.discount_pct > 0
        m.available, m.reason, m.discount_pct, m.substitute_for = True, None, 0, None
        for other in self.menu.values():
            if other.substitute_for == mid:
                other.discount_pct, other.substitute_for = 0, None
        return changed

    def set_discount(self, mid: str, pct: int, reason: str, substitute_for: Optional[str] = None) -> None:
        m = self.menu[mid]
        m.discount_pct, m.reason, m.substitute_for = pct, reason, substitute_for

    def restock(self, ingredient: str) -> None:
        inv = self.inventory[ingredient]
        inv.on_hand = inv.par
        inv.days_in_stock = 0
        inv.freshness = "fresh"

    def mark_turning(self, ingredient: str, level: str = "turning") -> None:
        self.inventory[ingredient].freshness = level

    def most_perishable_in(self, location: str) -> Optional[Ingredient]:
        cands = [i for i in self.inventory.values() if i.location == location and i.on_hand > 0]
        if not cands:
            return None
        return max(cands, key=lambda i: PERISHABILITY.get(i.name, 0.1) * (1 + 0.4 * i.days_in_stock))

    # ------------------------------------------------------------------ tick
    def tick(self, real_dt_s: float) -> None:
        dt = real_dt_s * SIM_MIN_PER_REAL_S * self.speed
        self.sim_minutes += dt
        self._next_arrival -= dt
        self._arrivals()
        self._progress_orders()
        self._update_burn_rates(dt)

    def snapshot(self) -> dict:
        return {
            "sim_minutes": round(self.sim_minutes, 2),
            "rush": self.rush,
            "speed": self.speed,
            "orders": [o.to_dict(self.sim_minutes) for o in self.orders],
            "inventory": [i.to_dict() for i in self.inventory.values()],
            "menu": [m.to_dict() for m in self.menu.values()],
            "metrics": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in self.metrics.items()},
        }
