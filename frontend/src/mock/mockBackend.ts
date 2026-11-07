import type { SousApi } from "../lib/api";
import type {
  Action,
  AnomalyKind,
  Event,
  Ingredient,
  MenuItem,
  Order,
  SmellScenario,
  State,
  WsMessage,
} from "../types";

/**
 * In-browser stand-in for the FastAPI backend. Activated with `?mock=1`.
 * Emits the same WsMessage shapes the real `/ws` does, once per second, and
 * implements every POST in CONTRACT.md against local state.
 *
 * Storyline (wall-clock seconds since start, at speed 1x):
 *   0s   kitchen opens, four orders already on the board, hearing live via soundtrack
 *   ~15s nose: VOC ratio starts climbing in the walk-in (spoilage scenario)
 *   ~25s nose anomaly confirmed -> agent hides guac-heavy items, speaks
 *   avocado burns fast; stockout forecast -> hide "Avocado Toast", promote substitute, draft reorder
 *   new orders every ~6s (every ~3s in rush), hearing events every 4-7s
 */

const MENU: MenuItem[] = [
  { id: "m-avo-toast", name: "Avocado Toast", price: 12, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "avocado", qty: 1 }, { name: "sourdough", qty: 2 }], tags: ["vegetarian", "popular"] },
  { id: "m-guac", name: "Guac & Chips", price: 9, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "avocado", qty: 2 }, { name: "tortilla chips", qty: 1 }], tags: ["vegan", "shareable"] },
  { id: "m-burger", name: "Smash Burger", price: 15, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "beef patty", qty: 2 }, { name: "brioche bun", qty: 1 }, { name: "cheddar", qty: 1 }], tags: ["popular"] },
  { id: "m-fries", name: "Hand-cut Fries", price: 6, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "potatoes", qty: 1 }, { name: "fryer oil", qty: 0.05 }], tags: ["vegan", "side"] },
  { id: "m-chicken", name: "Crispy Chicken Sandwich", price: 14, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "chicken thigh", qty: 1 }, { name: "brioche bun", qty: 1 }, { name: "fryer oil", qty: 0.08 }], tags: ["popular", "spicy"] },
  { id: "m-salad", name: "Little Gem Salad", price: 11, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "little gem", qty: 1 }, { name: "cheddar", qty: 0.5 }], tags: ["vegetarian", "gluten-free"] },
  { id: "m-tomato-toast", name: "Heirloom Tomato Toast", price: 11, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "tomatoes", qty: 1 }, { name: "sourdough", qty: 2 }], tags: ["vegan", "seasonal"] },
  { id: "m-shake", name: "Salted Caramel Shake", price: 8, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "ice cream", qty: 2 }], tags: ["dessert"] },
];

const INVENTORY: Ingredient[] = [
  { name: "avocado", unit: "ea", on_hand: 14, par: 40, burn_rate_per_min: 0.9, minutes_to_stockout: 16, freshness: "watch", days_in_stock: 4, location: "walk-in" },
  { name: "beef patty", unit: "ea", on_hand: 62, par: 80, burn_rate_per_min: 0.7, minutes_to_stockout: 88, freshness: "fresh", days_in_stock: 1, location: "walk-in" },
  { name: "chicken thigh", unit: "ea", on_hand: 38, par: 50, burn_rate_per_min: 0.45, minutes_to_stockout: 84, freshness: "fresh", days_in_stock: 1, location: "walk-in" },
  { name: "brioche bun", unit: "ea", on_hand: 70, par: 96, burn_rate_per_min: 1.1, minutes_to_stockout: 63, freshness: "fresh", days_in_stock: 1, location: "dry" },
  { name: "sourdough", unit: "slice", on_hand: 54, par: 80, burn_rate_per_min: 0.8, minutes_to_stockout: 67, freshness: "fresh", days_in_stock: 1, location: "dry" },
  { name: "potatoes", unit: "lb", on_hand: 41, par: 50, burn_rate_per_min: 0.3, minutes_to_stockout: 136, freshness: "fresh", days_in_stock: 3, location: "dry" },
  { name: "fryer oil", unit: "L", on_hand: 18, par: 20, burn_rate_per_min: 0.04, minutes_to_stockout: 450, freshness: "watch", days_in_stock: 5, location: "fry-station" },
  { name: "tomatoes", unit: "ea", on_hand: 30, par: 36, burn_rate_per_min: 0.2, minutes_to_stockout: 150, freshness: "fresh", days_in_stock: 2, location: "walk-in" },
  { name: "little gem", unit: "head", on_hand: 22, par: 30, burn_rate_per_min: 0.25, minutes_to_stockout: 88, freshness: "fresh", days_in_stock: 2, location: "walk-in" },
  { name: "cheddar", unit: "slice", on_hand: 90, par: 120, burn_rate_per_min: 0.6, minutes_to_stockout: 150, freshness: "fresh", days_in_stock: 6, location: "walk-in" },
  { name: "tortilla chips", unit: "bag", on_hand: 12, par: 20, burn_rate_per_min: 0.1, minutes_to_stockout: 120, freshness: "fresh", days_in_stock: 8, location: "dry" },
  { name: "ice cream", unit: "scoop", on_hand: 60, par: 80, burn_rate_per_min: 0.3, minutes_to_stockout: 200, freshness: "fresh", days_in_stock: 3, location: "walk-in" },
];

const CHANNELS: Order["channel"][] = ["doordash", "doordash", "ubereats", "ubereats", "phone", "walkin"];
const PREFIX: Record<Order["channel"], string> = { doordash: "D", ubereats: "U", phone: "P", walkin: "W" };

const SCENARIO_KIND: Record<string, AnomalyKind> = {
  spoilage_walkin: "spoilage",
  fryer_oil: "oil_degraded",
  burning: "burning",
  cleaning: "cleaning",
};
const SCENARIO_LOCATION: Record<string, string> = {
  spoilage_walkin: "walk-in",
  fryer_oil: "fry-station",
  burning: "fry-station",
  cleaning: "walk-in",
};
const SCENARIO_PEAK: Record<string, number> = { spoilage_walkin: 2.6, fryer_oil: 1.9, burning: 3.4, cleaning: 2.1 };

const HEARING_LINES: { kind: string; label: string; detail: string; severity: Event["severity"]; data: () => Record<string, unknown> }[] = [
  { kind: "ticket_burst", label: "Ticket printer burst", detail: "4 tickets in 6 s — expo is about to get buried", severity: "warn", data: () => ({ peak_hz: 3200 + rnd(400), flatness: 0.12 + Math.random() * 0.05, rms: 0.31 + Math.random() * 0.1, count: 4 }) },
  { kind: "fryer_alarm", label: "Fryer timer", detail: "Basket 2 beeping for 9 s with no response", severity: "alert", data: () => ({ peak_hz: 2800 + rnd(150), flatness: 0.04, rms: 0.42, duration_s: 9 }) },
  { kind: "door_chime", label: "Front door chime", detail: "Walk-in guest at the counter", severity: "info", data: () => ({ peak_hz: 1760, flatness: 0.08, rms: 0.18 }) },
  { kind: "noise_spike", label: "Noise spike", detail: "Dropped sheet pan near the dish pit", severity: "info", data: () => ({ peak_hz: 540 + rnd(300), flatness: 0.61, rms: 0.74 }) },
  { kind: "speech", label: "Line call-out", detail: "\"Behind! Hot pan!\"", severity: "info", data: () => ({ peak_hz: 420, flatness: 0.22, rms: 0.27 }) },
];

const ORDER_ITEMS: string[][] = [
  ["Avocado Toast"],
  ["Smash Burger", "Hand-cut Fries"],
  ["Crispy Chicken Sandwich", "Hand-cut Fries"],
  ["Guac & Chips", "Smash Burger"],
  ["Little Gem Salad"],
  ["Avocado Toast", "Salted Caramel Shake"],
  ["Heirloom Tomato Toast"],
  ["Smash Burger", "Smash Burger", "Hand-cut Fries", "Salted Caramel Shake"],
];

function rnd(n: number): number {
  return Math.round(Math.random() * n);
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export type MockBackend = { api: SousApi; start: () => void; stop: () => void };

export function createMockBackend(emit: (m: WsMessage) => void): MockBackend {
  let timer: number | null = null;
  let tick = 0;
  let orderSeq: Record<Order["channel"], number> = { doordash: 104, ubereats: 33, phone: 7, walkin: 12 };
  let speed = 1;
  let sinceOrder = 0;
  let sinceHearing = 0;
  let scenario: SmellScenario | null = null;
  let scenarioStartTick = 0;
  let scenarioAnnounced = false;
  let avocadoHidden = false;
  let reorderDrafted = false;
  let hearingSource: State["senses"]["hearing"]["source"] = "soundtrack";

  let state!: State; // assigned right after fresh() is defined (mkOrder reads state?.rush, undefined during the first fresh())

  function fresh(): State {
    const menu = MENU.map((m) => ({ ...m, ingredients: m.ingredients.map((i) => ({ ...i })), tags: [...m.tags] }));
    const inventory = INVENTORY.map((i) => ({ ...i }));
    const trace: State["senses"]["smell"]["trace"] = [];
    for (let i = -60; i < 0; i++) trace.push({ t: i, ratio: 1 + (Math.random() - 0.5) * 0.04 });
    const orders: Order[] = [
      mkOrder("doordash", 0, ["Smash Burger", "Hand-cut Fries"], -6, "cooking"),
      mkOrder("ubereats", 0, ["Avocado Toast", "Salted Caramel Shake"], -4, "fire"),
      mkOrder("phone", 0, ["Crispy Chicken Sandwich", "Hand-cut Fries"], -2, "queued"),
      mkOrder("walkin", 0, ["Little Gem Salad"], -1, "queued"),
    ];
    return {
      clock: new Date().toISOString(),
      sim_minutes: 0,
      rush: false,
      orders,
      inventory,
      menu,
      senses: {
        hearing: { active: true, source: hearingSource, noise_db: -34, stress: 0.22, recent: [] },
        smell: {
          device: "replay",
          sensor_id: "bme688-01",
          location: "walk-in",
          baseline_ohm: 182000,
          gas_ohm: 181200,
          ratio: 1.0,
          temp_c: 3.8,
          rh: 71,
          status: "nominal",
          anomaly: null,
          scenario: null,
          trace,
        },
      },
      voice: { last_line: "", muted: false },
      actions: [],
      metrics: { orders_served: 0, stockouts_prevented: 0, est_refunds_avoided_usd: 0, est_waste_saved_usd: 0 },
      providers: { llm: "rules", tts: "browser" },
    };
  }

  state = fresh();

  function mkOrder(channel: Order["channel"], now: number, names: string[], placedOffset: number, status: Order["status"] = "queued"): Order {
    const prep = 6 + names.length * 2 + rnd(2);
    const placed = now + placedOffset;
    const promised = placed + prep + ((state as State | undefined)?.rush ? 5 : 8);
    return {
      id: `${PREFIX[channel]}-${orderSeq[channel]++}`,
      channel,
      items: names.map((n) => ({ name: n, qty: 1 })),
      placed_at: placed,
      promised_at: promised,
      fire_at: promised - prep - 3, // 3 min buffer before the promised time
      prep_minutes: prep,
      status,
      dasher_eta_min: channel === "doordash" || channel === "ubereats" ? prep + 4 + rnd(6) : null,
      late_risk: "low",
    };
  }

  function pushEvent(ev: Omit<Event, "id" | "t">): Event {
    const full: Event = { ...ev, id: uid("ev"), t: new Date().toISOString() };
    if (full.sense === "hearing") {
      state.senses.hearing.recent = [full, ...state.senses.hearing.recent].slice(0, 10);
    }
    emit({ type: "event", event: full });
    return full;
  }

  function pushAction(a: Omit<Action, "id" | "t">): Action {
    const full: Action = { ...a, id: uid("act"), t: new Date().toISOString() };
    state.actions = [full, ...state.actions].slice(0, 30);
    emit({ type: "action", action: full });
    return full;
  }

  function speak(text: string) {
    state.voice.last_line = text;
    pushAction({ type: "speak", summary: text, payload: { text }, by: "rules" });
    emit({ type: "speak", text, id: uid("sp") });
  }

  function hideItem(id: string, reason: string) {
    const m = state.menu.find((x) => x.id === id);
    if (!m || !m.available) return;
    m.available = false;
    m.reason = reason;
    pushAction({ type: "menu_hide", summary: `Hid "${m.name}" on DoorDash and Uber Eats`, payload: { menu_id: id, reason }, by: "rules" });
  }

  function restoreItem(id: string, by: Action["by"] = "rules") {
    const m = state.menu.find((x) => x.id === id);
    if (!m) return;
    m.available = true;
    m.reason = null;
    m.discount_pct = 0;
    state.menu.forEach((s) => {
      if (s.substitute_for === id) s.substitute_for = null;
    });
    pushAction({ type: "menu_restore", summary: `Restored "${m.name}"`, payload: { menu_id: id }, by });
  }

  function startScenario(name: SmellScenario) {
    if (name === "stop" || name === "nominal") {
      scenario = null;
      state.senses.smell.scenario = name === "nominal" ? "nominal" : null;
      if (state.senses.smell.status === "anomaly") {
        pushEvent({ sense: "smell", kind: "voc_clear", label: "VOC cleared", detail: `${state.senses.smell.location} back to baseline`, severity: "info", data: { ratio: state.senses.smell.ratio } });
      }
      state.senses.smell.status = "nominal";
      state.senses.smell.anomaly = null;
      scenarioAnnounced = false;
      return;
    }
    scenario = name;
    scenarioStartTick = tick;
    scenarioAnnounced = false;
    state.senses.smell.scenario = name;
    state.senses.smell.location = SCENARIO_LOCATION[name];
    state.senses.smell.anomaly = null;
    state.senses.smell.status = "nominal";
    if (name === "fryer_oil" || name === "burning") {
      state.senses.smell.temp_c = 38;
      state.senses.smell.rh = 32;
    } else {
      state.senses.smell.temp_c = 3.8;
      state.senses.smell.rh = 71;
    }
  }

  function stepSmell() {
    const s = state.senses.smell;
    let target = 1;
    if (scenario) {
      const age = tick - scenarioStartTick;
      const peak = SCENARIO_PEAK[scenario];
      // ramp over ~12 s, hold, then slowly decay for cleaning
      const ramp = Math.min(1, age / 12);
      target = 1 + (peak - 1) * ramp;
      if (scenario === "cleaning" && age > 30) target = 1 + (peak - 1) * Math.max(0, 1 - (age - 30) / 25);
    }
    const prev = s.ratio ?? 1;
    const ratio = prev + (target - prev) * 0.25 + (Math.random() - 0.5) * 0.03;
    s.ratio = Math.max(0.8, Number(ratio.toFixed(3)));
    s.gas_ohm = s.baseline_ohm ? Math.round(s.baseline_ohm / s.ratio) : null;
    const t = s.trace.length ? s.trace[s.trace.length - 1].t + 1 : 0;
    s.trace = [...s.trace, { t, ratio: s.ratio }].slice(-180);
    if (s.temp_c !== null) s.temp_c = Number((s.temp_c + (Math.random() - 0.5) * 0.1).toFixed(1));
    if (s.rh !== null) s.rh = Math.round(s.rh + (Math.random() - 0.5) * 0.6);

    if (scenario && s.ratio > 1.35 && s.status !== "anomaly") {
      const kind = SCENARIO_KIND[scenario];
      s.status = "anomaly";
      s.anomaly = { kind, magnitude: Number((s.ratio - 1).toFixed(2)), since: new Date().toISOString() };
      pushEvent({ sense: "smell", kind: "voc_rise", label: "VOC rising", detail: `ratio ${s.ratio.toFixed(2)} at ${s.location}, derivative +0.08/s`, severity: "warn", data: { ratio: s.ratio, location: s.location } });
    } else if (s.status === "anomaly" && s.anomaly) {
      s.anomaly.magnitude = Number((s.ratio - 1).toFixed(2));
      if (s.ratio < 1.15) {
        s.status = "nominal";
        s.anomaly = null;
        pushEvent({ sense: "smell", kind: "voc_clear", label: "VOC cleared", detail: `${s.location} back to baseline`, severity: "info", data: { ratio: s.ratio } });
      }
    }

    if (scenario && s.status === "anomaly" && !scenarioAnnounced && s.ratio > 1.8) {
      scenarioAnnounced = true;
      const kind = SCENARIO_KIND[scenario];
      if (kind === "spoilage") {
        pushEvent({ sense: "smell", kind: "spoilage", label: "Spoilage signature", detail: "Ethanol/ester profile consistent with produce turning in the walk-in", severity: "alert", data: { ratio: s.ratio, location: s.location, kind } });
        const avo = state.inventory.find((i) => i.name === "avocado");
        if (avo) avo.freshness = "turning";
        const tom = state.inventory.find((i) => i.name === "tomatoes");
        if (tom) tom.freshness = "watch";
        pushEvent({ sense: "agent", kind: "decision", label: "Fused nose + inventory", detail: "Avocado is 4 days in, VOCs rising at its shelf. Pulling guac before a refund does.", severity: "warn", data: { confidence: 0.82 } });
        hideItem("m-guac", "Walk-in VOC anomaly; avocado freshness flagged by nose");
        state.metrics.stockouts_prevented += 1;
        state.metrics.est_refunds_avoided_usd += 54;
        state.metrics.est_waste_saved_usd += 38;
        speak("Heads up — I'm smelling something turning in the walk-in, near the avocados. I've pulled Guac and Chips from the apps. Can someone check that bottom shelf?");
      } else if (kind === "oil_degraded") {
        pushEvent({ sense: "smell", kind: "oil_degraded", label: "Fryer oil degraded", detail: "Aldehyde profile rising at fry-station; oil past its change window", severity: "warn", data: { ratio: s.ratio, location: s.location, kind } });
        const oil = state.inventory.find((i) => i.name === "fryer oil");
        if (oil) oil.freshness = "turning";
        pushAction({ type: "ask_human", summary: "Fryer oil smells degraded — change before dinner?", payload: { station: "fry-station", ratio: s.ratio }, by: "rules" });
        speak("The fryer oil is reading degraded. Fries will taste off within the hour — I'd swap it before dinner rush.");
      } else if (kind === "burning") {
        pushEvent({ sense: "smell", kind: "burning", label: "Burning detected", detail: "Sharp VOC spike at fry-station; smoke profile", severity: "alert", data: { ratio: s.ratio, location: s.location, kind } });
        speak("Something is burning at the fry station. Check basket two right now.");
      } else if (kind === "cleaning") {
        pushEvent({ sense: "smell", kind: "cleaning", label: "Cleaning cycle", detail: "Chlorine/surfactant profile in walk-in — not spoilage, suppressing alerts for 20 min", severity: "info", data: { ratio: s.ratio, location: s.location, kind } });
        speak("I smell sanitizer in the walk-in. I'll treat that as a cleaning cycle and hold off on spoilage alerts for a bit.");
      }
    }
  }

  function stepOrders(dtMin: number) {
    const now = state.sim_minutes;
    for (const o of state.orders) {
      if (o.status === "picked_up") continue;
      if (o.dasher_eta_min !== null && o.status !== "ready") o.dasher_eta_min = Math.max(0, o.dasher_eta_min - dtMin);
      if (o.status === "queued" && now >= o.fire_at) {
        o.status = "fire";
      }
      if (o.status === "fire" && now >= o.fire_at + 1.2) {
        o.status = "cooking";
      }
      if (o.status === "cooking" && now >= o.fire_at + o.prep_minutes) {
        o.status = "ready";
        pushEvent({ sense: "orders", kind: "ready", label: `${o.id} ready`, detail: o.items.map((i) => i.name).join(", "), severity: "info", data: { order_id: o.id } });
      }
      if (o.status === "ready" && now >= o.promised_at + 1.5) {
        o.status = "picked_up";
        state.metrics.orders_served += 1;
        pushEvent({ sense: "orders", kind: "picked_up", label: `${o.id} picked up`, detail: o.channel === "walkin" ? "Handed to guest" : "Handed to driver", severity: "info", data: { order_id: o.id } });
      }
      // expected ready time: cooking orders finish at fire_at + prep; others start no earlier than now
      const expectedReady = o.status === "cooking" ? o.fire_at + o.prep_minutes : Math.max(now, o.fire_at) + o.prep_minutes;
      const slack = o.promised_at - expectedReady;
      o.late_risk = o.status === "ready" || o.status === "picked_up" ? "low" : slack < 0 ? "high" : slack < 2 ? "med" : "low";
      // Dasher will be waiting at the door before the food is ready -> pull the ticket forward.
      if (o.status === "queued" && o.dasher_eta_min !== null && o.dasher_eta_min <= o.prep_minutes + 1 && now < o.fire_at) {
        o.status = "fire";
        o.fire_at = now;
        pushAction({ type: "fire_now", summary: `Fire ${o.id} now — ${o.channel === "doordash" ? "dasher" : "courier"} is ${Math.round(o.dasher_eta_min)} min out`, payload: { order_id: o.id, dasher_eta_min: Math.round(o.dasher_eta_min) }, by: "rules" });
      }
    }
    // keep newest first, max 24
    state.orders = state.orders.filter((o) => o.status !== "picked_up" || now - o.promised_at < 8).slice(0, 24);
  }

  function stepInventory(dtMin: number) {
    const rushMult = state.rush ? 1.8 : 1;
    for (const ing of state.inventory) {
      const burn = ing.burn_rate_per_min * rushMult;
      ing.on_hand = Math.max(0, Number((ing.on_hand - burn * dtMin).toFixed(2)));
      ing.minutes_to_stockout = burn > 0 ? Math.round(ing.on_hand / burn) : null;
    }
    const avo = state.inventory.find((i) => i.name === "avocado");
    if (avo && !avocadoHidden && avo.minutes_to_stockout !== null && avo.minutes_to_stockout <= 8) {
      avocadoHidden = true;
      pushEvent({ sense: "orders", kind: "late", label: "Stockout forecast", detail: `Avocado hits zero in ~${avo.minutes_to_stockout} min at current burn; 3 queued orders need it`, severity: "warn", data: { ingredient: "avocado", minutes: avo.minutes_to_stockout } });
      pushEvent({ sense: "agent", kind: "decision", label: "Protect the storefront", detail: "Hide Avocado Toast before it 86es mid-order; promote Tomato Toast as the swap.", severity: "warn", data: { confidence: 0.91 } });
      hideItem("m-avo-toast", "Avocado forecast to stock out in under 10 min");
      const tt = state.menu.find((m) => m.id === "m-tomato-toast");
      if (tt) {
        tt.substitute_for = "m-avo-toast";
        tt.discount_pct = 15;
        tt.reason = "Promoted while Avocado Toast is unavailable";
        pushAction({ type: "substitute", summary: `Promoting "${tt.name}" in place of Avocado Toast (15% off)`, payload: { menu_id: tt.id, substitute_for: "m-avo-toast", discount_pct: 15 }, by: "rules" });
        pushAction({ type: "menu_discount", summary: `15% off "${tt.name}"`, payload: { menu_id: tt.id, discount_pct: 15 }, by: "rules" });
      }
      state.metrics.stockouts_prevented += 1;
      state.metrics.est_refunds_avoided_usd += 36;
      speak("Avocados are about to run out. I've hidden Avocado Toast on DoorDash and Uber Eats and I'm pushing the Tomato Toast instead.");
    }
    if (avo && !reorderDrafted && avocadoHidden) {
      reorderDrafted = true;
      pushAction({
        type: "reorder_draft",
        summary: "Reorder draft: 2 cases avocado (48 ea), Sysco, next-morning",
        payload: {
          supplier: "Sysco",
          deliver_by: "tomorrow 07:00",
          lines: [
            { name: "avocado", qty: 48, unit: "ea", note: "2 cases, Hass, stage 3 ripeness" },
            { name: "tomatoes", qty: 24, unit: "ea", note: "heirloom mix for Tomato Toast demand" },
          ],
          est_cost_usd: 118.4,
          status: "draft — needs manager approval",
        },
        by: "rules",
      });
    }
  }

  function stepHearing() {
    const h = state.senses.hearing;
    if (!h.active) {
      h.noise_db = -60;
      h.stress = Math.max(0, h.stress - 0.02);
      return;
    }
    const base = state.rush ? -22 : -34;
    h.noise_db = Math.max(-60, Math.min(0, base + (Math.random() - 0.5) * 8));
    const activeTickets = state.orders.filter((o) => o.status !== "picked_up" && o.status !== "ready").length;
    const target = Math.min(1, 0.15 + activeTickets * 0.06 + (h.noise_db + 40) / 80);
    h.stress = Number((h.stress + (target - h.stress) * 0.2).toFixed(2));
    sinceHearing += 1;
    const gap = state.rush ? 3 : 5;
    if (sinceHearing >= gap + rnd(2)) {
      sinceHearing = 0;
      const pick = HEARING_LINES[Math.floor(Math.random() * HEARING_LINES.length)];
      pushEvent({ sense: "hearing", kind: pick.kind, label: pick.label, detail: pick.detail, severity: pick.severity, data: pick.data() });
      if (pick.kind === "fryer_alarm") {
        speak("Fryer two has been beeping for ten seconds. Someone pull that basket.");
      } else if (pick.kind === "ticket_burst" && state.rush) {
        speak("Four tickets just hit. Fire the two burgers first — the dasher for D-one-oh-six is three minutes out.");
      }
    }
  }

  function maybeNewOrder() {
    sinceOrder += 1;
    const gap = state.rush ? 3 : 6;
    if (sinceOrder < gap) return;
    sinceOrder = 0;
    const channel = CHANNELS[Math.floor(Math.random() * CHANNELS.length)];
    const available = new Set(state.menu.filter((m) => m.available).map((m) => m.name));
    const candidates = ORDER_ITEMS.filter((names) => names.every((n) => available.has(n)));
    const names = (candidates.length ? candidates : ORDER_ITEMS)[Math.floor(Math.random() * (candidates.length || ORDER_ITEMS.length))];
    const o = mkOrder(channel, state.sim_minutes, names, 0);
    state.orders = [o, ...state.orders].slice(0, 24);
    pushEvent({ sense: "orders", kind: "placed", label: `${o.id} placed`, detail: `${names.join(", ")} via ${channel}`, severity: "info", data: { order_id: o.id, channel } });
    // deduct recipe-level inventory immediately so the forecast reacts
    for (const n of names) {
      const m = state.menu.find((x) => x.name === n);
      m?.ingredients.forEach((ing) => {
        const inv = state.inventory.find((i) => i.name === ing.name);
        if (inv) inv.on_hand = Math.max(0, Number((inv.on_hand - ing.qty).toFixed(2)));
      });
    }
  }

  function step() {
    tick += 1;
    const dtMin = 0.35 * speed; // each real second advances ~21 s of kitchen time at 1x
    state.sim_minutes = Number((state.sim_minutes + dtMin).toFixed(2));
    state.clock = new Date().toISOString();
    if (tick === 15 && scenario === null && state.senses.smell.scenario === null) startScenario("spoilage_walkin");
    if (tick === 3) {
      pushEvent({ sense: "smell", kind: "device_connected", label: "Replay source connected", detail: "No board on serial/http — replaying recorded trace via POST /api/sensor/reading", severity: "info", data: { device: "replay", sensor_id: "bme688-01" } });
    }
    if (tick === 2) speak("Sous is online. Ears and nose are live — four tickets on the board, walk-in reads nominal.");
    stepSmell();
    stepOrders(dtMin);
    stepInventory(dtMin);
    stepHearing();
    maybeNewOrder();
    emit({ type: "snapshot", state: snapshot() });
  }

  function snapshot(): State {
    // shallow-clone top levels so React sees new references each tick
    return {
      ...state,
      orders: state.orders.map((o) => ({ ...o, items: [...o.items] })),
      inventory: state.inventory.map((i) => ({ ...i })),
      menu: state.menu.map((m) => ({ ...m })),
      senses: {
        hearing: { ...state.senses.hearing, recent: [...state.senses.hearing.recent] },
        smell: { ...state.senses.smell, trace: [...state.senses.smell.trace], anomaly: state.senses.smell.anomaly ? { ...state.senses.smell.anomaly } : null },
      },
      voice: { ...state.voice },
      actions: [...state.actions],
      metrics: { ...state.metrics },
      providers: { ...state.providers },
    };
  }

  const api: SousApi = {
    health: async () => ({ ok: true, providers: state.providers, smell_device: state.senses.smell.device }),
    getState: async () => snapshot(),
    control: async (body) => {
      if (body.rush !== undefined) {
        state.rush = body.rush;
        pushEvent({ sense: "agent", kind: "decision", label: body.rush ? "Rush mode on" : "Rush mode off", detail: body.rush ? "Expecting 2x ticket rate; tightening fire times" : "Back to normal pacing", severity: "info", data: { rush: body.rush } });
      }
      if (body.muted !== undefined) state.voice.muted = body.muted;
      if (body.speed !== undefined) speed = body.speed;
    },
    reset: async () => {
      tick = 0;
      sinceOrder = 0;
      sinceHearing = 0;
      scenario = null;
      scenarioAnnounced = false;
      avocadoHidden = false;
      reorderDrafted = false;
      orderSeq = { doordash: 104, ubereats: 33, phone: 7, walkin: 12 };
      const muted = state.voice.muted;
      state = fresh();
      state.voice.muted = muted;
      emit({ type: "snapshot", state: snapshot() });
    },
    restoreMenuItem: async (id) => {
      restoreItem(id, "rules");
      pushEvent({ sense: "agent", kind: "decision", label: "Human override", detail: `Staff restored ${state.menu.find((m) => m.id === id)?.name ?? id} — "we got more"`, severity: "info", data: { menu_id: id } });
      if (id === "m-avo-toast") {
        const avo = state.inventory.find((i) => i.name === "avocado");
        if (avo) {
          avo.on_hand = 40;
          avo.freshness = "fresh";
          avo.days_in_stock = 0;
        }
        avocadoHidden = false;
        reorderDrafted = false;
      }
      emit({ type: "snapshot", state: snapshot() });
    },
    smellScenario: async (name) => {
      startScenario(name);
      pushEvent({ sense: "smell", kind: "device_connected", label: `Scenario: ${name}`, detail: "Replaying through POST /api/sensor/reading", severity: "info", data: { scenario: name } });
    },
    sensorReading: async (body) => {
      state.senses.smell.device = "http";
      state.senses.smell.sensor_id = body.sensor_id;
      state.senses.smell.location = body.location;
      state.senses.smell.gas_ohm = body.gas_ohm;
      state.senses.smell.temp_c = body.temp_c;
      state.senses.smell.rh = body.rh;
    },
    hearingInject: async (kind) => {
      const line = HEARING_LINES.find((l) => l.kind === kind) ?? HEARING_LINES[0];
      pushEvent({ sense: "hearing", kind, label: `${line.label} (injected)`, detail: line.detail, severity: line.severity, data: { ...line.data(), injected: true } });
      if (kind === "fryer_alarm") speak("Fryer alarm — pull basket two.");
      if (kind === "ticket_burst") speak("Ticket burst. Fire the burgers first.");
      if (kind === "door_chime") speak("Someone's at the counter.");
    },
    speak: async () => null, // mock has no TTS provider -> speechSynthesis fallback
  };

  return {
    api,
    start: () => {
      if (timer !== null) return;
      emit({ type: "snapshot", state: snapshot() });
      timer = window.setInterval(step, 1000);
    },
    stop: () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    },
  };
}
