import type { SousApi } from "../lib/api";
import { getMicId, getMicLocation } from "../lib/device";
import { countItems, DEFAULT_LABELS } from "../lib/normalise";
import type { Action, Event, Ingredient, Item, Items, MenuItem, Mic, Order, Smell, SmellScenario, SoundClip, State, Urgency, WsMessage } from "../types";

/**
 * In-browser stand-in for the FastAPI backend (CONTRACT v2). Activated with `?mock=1`.
 * Emits the same WsMessage shapes the real `/ws` does, once per second, and implements
 * every REST call in CONTRACT.md against local state.
 *
 * Storyline (wall-clock seconds since start, at speed 1x):
 *   0s   kitchen opens, four orders on the board, two mics listening (this device + a phone at the front)
 *   ~15s nose: 4-step fingerprint drifts in the walk-in (spoilage_walkin scenario)
 *   ~25s nose anomaly -> item "Check the walk-in bottom shelf" (now), Sous hides guac, speaks
 *   avocado burns fast; stockout forecast -> item + hide "Avocado Toast", promote substitute, draft reorder
 *   hearing events every 4-7 s become items (merged by kind+location); new orders every ~6 s (~3 s in rush)
 */

const MENU: MenuItem[] = [
  { id: "m-avo-toast", name: "Avocado Toast", emoji: "🥑", price: 12, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "avocado", qty: 1 }, { name: "sourdough", qty: 2 }], tags: ["vegetarian", "popular"] },
  { id: "m-guac", name: "Guac & Chips", emoji: "🫔", price: 9, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "avocado", qty: 2 }, { name: "tortilla chips", qty: 1 }], tags: ["vegan", "shareable"] },
  { id: "m-burger", name: "Smash Burger", emoji: "🍔", price: 15, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "beef patty", qty: 2 }, { name: "brioche bun", qty: 1 }, { name: "cheddar", qty: 1 }], tags: ["popular"] },
  { id: "m-fries", name: "Hand-cut Fries", emoji: "🍟", price: 6, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "potatoes", qty: 1 }, { name: "fryer oil", qty: 0.05 }], tags: ["vegan", "side"] },
  { id: "m-chicken", name: "Crispy Chicken Sandwich", emoji: "🍗", price: 14, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "chicken thigh", qty: 1 }, { name: "brioche bun", qty: 1 }, { name: "fryer oil", qty: 0.08 }], tags: ["popular", "spicy"] },
  { id: "m-salad", name: "Little Gem Salad", emoji: "🥗", price: 11, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "little gem", qty: 1 }, { name: "cheddar", qty: 0.5 }], tags: ["vegetarian", "gluten-free"] },
  { id: "m-tomato-toast", name: "Heirloom Tomato Toast", emoji: "🍅", price: 11, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "tomatoes", qty: 1 }, { name: "sourdough", qty: 2 }], tags: ["vegan", "seasonal"] },
  { id: "m-shake", name: "Salted Caramel Shake", emoji: "🥤", price: 8, available: true, discount_pct: 0, reason: null, substitute_for: null, ingredients: [{ name: "ice cream", qty: 2 }], tags: ["dessert"] },
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

// --- nose: 4-step heater sweep signatures (baseline/gas per step; 1.0 = clean air) -----------------
const SMELL_CLASSES = ["nominal", "spoilage_produce", "spoilage_protein", "burning", "oil_degraded", "cleaning"] as const;
type SmellClass = (typeof SMELL_CLASSES)[number];

const SCENARIO_META: Record<Exclude<SmellScenario, "stop" | "nominal">, { cls: SmellClass | "door_open"; location: string; sig: number[]; urgency: "now" | "next" | "today" | "info"; title: string; detail: string; speak: string | null }> = {
  spoilage_walkin: { cls: "spoilage_produce", location: "walk-in", sig: [1.55, 2.05, 2.4, 1.85], urgency: "next", title: "Check the walk-in bottom shelf", detail: "Ethanol/ester fingerprint rising near the avocados. Sous pulled Guac & Chips from the apps.", speak: "Heads up — I'm smelling something turning in the walk-in, near the avocados. I've pulled Guac and Chips from the apps. Can someone check that bottom shelf?" },
  spoilage_protein: { cls: "spoilage_protein", location: "walk-in", sig: [1.35, 1.7, 2.55, 2.3], urgency: "now", title: "Pull and check the protein in the walk-in", detail: "Amine/sulfur fingerprint — consistent with meat or fish turning. Smash Burger and Chicken Sandwich held.", speak: "Something protein is turning in the walk-in. I'm holding burgers and chicken until someone checks the top shelf." },
  fryer_oil: { cls: "oil_degraded", location: "fry-station", sig: [1.2, 1.5, 1.9, 1.6], urgency: "today", title: "Change the fryer oil before dinner", detail: "Aldehyde profile at the fry station says the oil is past its window. Fries will taste off within the hour.", speak: "The fryer oil is reading degraded. Fries will taste off within the hour — I'd swap it before dinner rush." },
  burning: { cls: "burning", location: "fry-station", sig: [2.8, 3.4, 3.1, 2.2], urgency: "now", title: "Something is burning at the fry station", detail: "Sharp smoke fingerprint on all four heater steps. Check basket two.", speak: "Something is burning at the fry station. Check basket two right now." },
  cleaning: { cls: "cleaning", location: "walk-in", sig: [0.72, 0.8, 1.9, 2.4], urgency: "info", title: "Cleaning cycle in the walk-in", detail: "Chlorine/surfactant profile — not spoilage. Spoilage alerts suppressed for 20 min.", speak: "I smell sanitizer in the walk-in. I'll treat that as a cleaning cycle and hold off on spoilage alerts for a bit." },
  door_open: { cls: "door_open", location: "walk-in", sig: [1.04, 1.07, 1.1, 1.06], urgency: "info", title: "Walk-in door is open", detail: "Small uniform shift across steps with a humidity jump — door open, not spoilage.", speak: null },
};

const CLASS_SIG: Record<SmellClass, number[]> = {
  nominal: [1, 1, 1, 1],
  spoilage_produce: SCENARIO_META.spoilage_walkin.sig,
  spoilage_protein: SCENARIO_META.spoilage_protein.sig,
  burning: SCENARIO_META.burning.sig,
  oil_degraded: SCENARIO_META.fryer_oil.sig,
  cleaning: SCENARIO_META.cleaning.sig,
};

// --- ears -------------------------------------------------------------------------------------------
const SCORE_KEYS = ["fryer_alarm", "door_chime", "ticket_burst", "clatter", "phone_ring", "speech", "frying"] as const;
const AUDIOSET_IDLE: [string, number][][] = [
  [["Speech", 0.31], ["Inside, small room", 0.22], ["Frying (food)", 0.14]],
  [["Inside, small room", 0.28], ["Sizzle", 0.19], ["Dishes, pots, and pans", 0.11]],
  [["Frying (food)", 0.26], ["Speech", 0.2], ["Water tap, faucet", 0.09]],
];
const HEARING_LINES: { kind: string; label: string; heard_as: string; detail: string; severity: Event["severity"]; urgency: Urgency; title: (loc: string) => string; itemDetail: string; speak: string | null; auto: Item["auto"] }[] = [
  { kind: "ticket_burst", label: "Ticket printer burst", heard_as: "Printer", detail: "4 tickets in 6 s — expo is about to get buried", severity: "warn", urgency: "next", title: () => "Fire the two burgers first", itemDetail: "Four tickets printed in six seconds. The DoorDash dasher for D-106 is three minutes out.", speak: "Four tickets just hit. Fire the two burgers first — the dasher for D-one-oh-six is three minutes out.", auto: { type: "fire_now", summary: "Fired D-106 early (dasher 3 min out)" } },
  { kind: "fryer_alarm", label: "Fryer alarm", heard_as: "Beep, bleep", detail: "Basket 2 beeping for 9 s with no response", severity: "alert", urgency: "now", title: () => "Pull fryer basket two", itemDetail: "The fryer timer has been beeping for nine seconds with nobody answering it.", speak: "Fryer two has been beeping for ten seconds. Someone pull that basket.", auto: null },
  { kind: "door_chime", label: "Front door chime", heard_as: "Doorbell", detail: "Walk-in guest at the counter", severity: "info", urgency: "today", title: () => "Guest at the counter", itemDetail: "The front door chimed and nobody is at the register.", speak: null, auto: null },
  { kind: "phone_ring", label: "Phone ringing", heard_as: "Telephone bell ringing", detail: "Landline ringing at the pass", severity: "warn", urgency: "next", title: () => "Answer the phone — likely an order", itemDetail: "The landline has rung four times. Phone orders are 18% of lunch.", speak: "Phone's ringing at the pass.", auto: null },
  { kind: "clatter", label: "Clatter", heard_as: "Dishes, pots, and pans", detail: "Dropped sheet pan near the dish pit", severity: "info", urgency: "later", title: () => "Check the dish pit", itemDetail: "Something metal hit the floor near the dish pit. Probably fine.", speak: null, auto: null },
];

const SOUND_CLIPS: SoundClip[] = [
  { id: "ticket_printer", name: "Ticket printer", kind: "ticket_burst", emoji: "🧾", hint: "An order printed off the POS", available: true, url: "/api/sounds/ticket_printer.wav" },
  { id: "fryer_alarm", name: "Fryer alarm", kind: "fryer_alarm", emoji: "🍟", hint: "Fryer timer beeping", available: true, url: "/api/sounds/fryer_alarm.wav" },
  { id: "door_chime", name: "Door chime", kind: "door_chime", emoji: "🔔", hint: "Someone at the front door", available: true, url: "/api/sounds/door_chime.wav" },
  { id: "phone_ring", name: "Phone ringing", kind: "phone_ring", emoji: "📞", hint: "Landline order coming in", available: true, url: "/api/sounds/phone_ring.wav" },
  { id: "plates_crash", name: "Plates crash", kind: "clatter", emoji: "🍽️", hint: "Something dropped", available: true, url: "/api/sounds/plates_crash.wav" },
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
function softmax(scores: number[], temp = 1): number[] {
  const m = Math.max(...scores);
  const ex = scores.map((s) => Math.exp((s - m) / temp));
  const sum = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / sum);
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
  let smellItemId: string | null = null;

  let state!: State;

  function mkMic(mic: string, location: string, source: Mic["source"]): Mic {
    return {
      mic,
      location,
      source,
      model: "yamnet",
      level_db: -38,
      floor_db: -46,
      active: true,
      speech_fraction: 0.18,
      scores: Object.fromEntries(SCORE_KEYS.map((k) => [k, k === "speech" ? 0.22 : k === "frying" ? 0.15 : 0.03 + Math.random() * 0.04])),
      top: AUDIOSET_IDLE[0],
      taught: { _background: 0.91 },
      teaching: null,
      windows: 0,
    };
  }

  function fresh(): State {
    const menu = MENU.map((m) => ({ ...m, ingredients: m.ingredients.map((i) => ({ ...i })), tags: [...m.tags] }));
    const inventory = INVENTORY.map((i) => ({ ...i }));
    const trace: Smell["trace"] = [];
    for (let i = -60; i < 0; i++) {
      const ratios = CLASS_SIG.nominal.map((r) => r + (Math.random() - 0.5) * 0.04);
      trace.push({ t: i, ratio: Number((ratios.reduce((a, b) => a + b, 0) / 4).toFixed(3)), ratios });
    }
    const orders: Order[] = [
      mkOrder("doordash", 0, ["Smash Burger", "Hand-cut Fries"], -6, "cooking"),
      mkOrder("ubereats", 0, ["Avocado Toast", "Salted Caramel Shake"], -4, "fire"),
      mkOrder("phone", 0, ["Crispy Chicken Sandwich", "Hand-cut Fries"], -2, "queued"),
      mkOrder("walkin", 0, ["Little Gem Salad"], -1, "queued"),
    ];
    const mics = [mkMic(getMicId(), getMicLocation(), "mic"), mkMic("phone-2a", "front", "mic")];
    mics[1].level_db = -44;
    mics[1].floor_db = -52;
    mics[1].speech_fraction = 0.41;
    mics[1].top = AUDIOSET_IDLE[1];
    return {
      clock: new Date().toISOString(),
      sim_minutes: 0,
      rush: false,
      speed,
      orders,
      inventory,
      menu,
      metrics: { orders_served: 0, stockouts_prevented: 0, est_refunds_avoided_usd: 0, est_waste_saved_usd: 0 },
      senses: {
        hearing: { active: true, source: "mic", noise_db: -34, stress: 0.22, recent: [] },
        ears: {
          active: true,
          model: "yamnet",
          mics,
          prototypes: [
            { label: "_background", examples: 24, name: "Room background" },
            { label: "door_chime", examples: 8, name: "Door chime" },
          ],
          labels: DEFAULT_LABELS,
        },
        smell: {
          device: "replay",
          sensor_id: "sim-bme688",
          location: "walk-in",
          status: "nominal",
          calibration: { status: "calibrated", quality: 0.93, baseline_ohm: [182000, 151000, 118000, 94000], rh_slope: -0.012, samples: 412 },
          ratios: [1, 1, 1, 1],
          fingerprint: [0, 0, 0, 0],
          probs: { nominal: 0.96, spoilage_produce: 0.01, spoilage_protein: 0.01, burning: 0.0, oil_degraded: 0.01, cleaning: 0.01 },
          anomaly: null,
          scenario: null,
          trace,
          model: { name: "gbdt-fingerprint", features: 22, trained_on: 6000, accuracy: 0.94 },
          single_channel: false,
          temp_c: 3.8,
          rh: 71,
        },
      },
      items: { open: [], recent_closed: [], counts: { now: 0, next: 0, today: 0, later: 0 }, total_created: 0 },
      voice: { last_line: "", muted: false },
      actions: [],
      providers: { llm: "rules", tts: "none", ears: "ready", nose: "replay" },
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
      fire_at: promised - prep - 3,
      prep_minutes: prep,
      status,
      dasher_eta_min: channel === "doordash" || channel === "ubereats" ? prep + 4 + rnd(6) : null,
      late_risk: "low",
    };
  }

  function pushEvent(ev: Omit<Event, "id" | "t">): Event {
    const full: Event = { ...ev, id: uid("ev"), t: new Date().toISOString() };
    if (full.sense === "hearing") state.senses.hearing.recent = [full, ...state.senses.hearing.recent].slice(0, 10);
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

  // --- items -----------------------------------------------------------------
  function recount() {
    state.items.counts = countItems(state.items.open);
  }

  function upsertItem(partial: Omit<Item, "id" | "created" | "updated" | "status" | "count"> & { mergeKey?: string }): Item {
    const now = new Date().toISOString();
    const existing = state.items.open.find((i) => i.kind === partial.kind && i.sense === partial.sense && (i.location ?? "") === (partial.location ?? ""));
    if (existing) {
      existing.count += 1;
      existing.updated = now;
      existing.detail = partial.detail;
      existing.evidence = partial.evidence;
      if (partial.auto) existing.auto = partial.auto;
      // repeats escalate: a third door chime in a row is "next", not "today"
      if (existing.count >= 3 && existing.urgency === "today") existing.urgency = "next";
      recount();
      emit({ type: "item", change: "updated", item: { ...existing } });
      return existing;
    }
    const { mergeKey: _k, ...rest } = partial;
    void _k;
    const item: Item = { ...rest, id: uid("it"), created: now, updated: now, status: "open", count: 1 };
    state.items.open = [item, ...state.items.open];
    state.items.total_created += 1;
    recount();
    emit({ type: "item", change: "added", item: { ...item } });
    return item;
  }

  function closeItem(id: string, status: Item["status"], by: NonNullable<Item["closed_by"]>) {
    const idx = state.items.open.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const [item] = state.items.open.splice(idx, 1);
    item.status = status;
    item.closed = new Date().toISOString();
    item.closed_by = by;
    state.items.recent_closed = [item, ...state.items.recent_closed].slice(0, 20);
    if (smellItemId === id) smellItemId = null;
    recount();
    emit({ type: "item", change: "closed", item: { ...item } });
  }

  function expireItems() {
    const now = Date.now();
    for (const it of [...state.items.open]) {
      const age = (now - new Date(it.updated).getTime()) / 1000;
      const ttl = it.urgency === "later" ? 60 : it.urgency === "today" ? 120 : it.urgency === "next" ? 180 : 300;
      if (age > ttl && it.sense !== "smell") closeItem(it.id, "expired", "timeout");
    }
  }

  // --- menu actions ---------------------------------------------------------------
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

  // --- nose -----------------------------------------------------------------------
  function startScenario(name: SmellScenario) {
    const s = state.senses.smell;
    if (name === "stop" || name === "nominal") {
      scenario = null;
      s.scenario = name === "nominal" ? "nominal" : null;
      if (s.status === "anomaly") pushEvent({ sense: "smell", kind: "voc_clear", label: "VOC cleared", detail: `${s.location} back to baseline`, severity: "info", data: { ratios: s.ratios } });
      s.status = "nominal";
      s.anomaly = null;
      if (smellItemId) closeItem(smellItemId, "done", "sous");
      scenarioAnnounced = false;
      return;
    }
    scenario = name;
    scenarioStartTick = tick;
    scenarioAnnounced = false;
    s.scenario = name;
    s.location = SCENARIO_META[name].location;
    s.anomaly = null;
    s.status = "nominal";
    if (smellItemId) closeItem(smellItemId, "done", "sous");
    const hot = name === "fryer_oil" || name === "burning";
    s.temp_c = hot ? 38 : 3.8;
    s.rh = hot ? 32 : name === "door_open" ? 84 : 71;
  }

  function stepSmell() {
    const s = state.senses.smell;
    let target = CLASS_SIG.nominal;
    if (scenario && scenario !== "stop" && scenario !== "nominal") {
      const meta = SCENARIO_META[scenario];
      const age = tick - scenarioStartTick;
      const ramp = Math.min(1, age / 12);
      let k = ramp;
      if (scenario === "cleaning" && age > 30) k = Math.max(0, 1 - (age - 30) / 25);
      if (scenario === "door_open" && age > 20) k = Math.max(0, 1 - (age - 20) / 10);
      target = meta.sig.map((v) => 1 + (v - 1) * k);
    }
    const prev = s.ratios ?? CLASS_SIG.nominal;
    const ratios = prev.map((p, i) => Math.max(0.5, Number((p + (target[i] - p) * 0.25 + (Math.random() - 0.5) * 0.03).toFixed(3))));
    s.ratios = ratios;
    const mean = ratios.reduce((a, b) => a + b, 0) / 4;
    s.ratio = Number(mean.toFixed(3));
    s.fingerprint = ratios.map((r) => Number((Math.log(r) - Math.log(ratios[1])).toFixed(3)));
    s.gas_ohm = s.calibration.baseline_ohm ? Math.round(s.calibration.baseline_ohm[1] / ratios[1]) : null;
    const t = s.trace.length ? Number((s.trace[s.trace.length - 1].t + 1).toFixed(1)) : 0;
    s.trace = [...s.trace, { t, ratio: s.ratio, ratios }].slice(-180);
    if (typeof s.temp_c === "number") s.temp_c = Number((s.temp_c + (Math.random() - 0.5) * 0.1).toFixed(1));
    if (typeof s.rh === "number") s.rh = Math.round(s.rh + (Math.random() - 0.5) * 0.6);

    // classifier: negative squared distance in log-space to each class signature
    const logR = ratios.map((r) => Math.log(r));
    const dists = SMELL_CLASSES.map((c) => {
      const sig = CLASS_SIG[c].map((r) => Math.log(r));
      return -sig.reduce((acc, v, i) => acc + (v - logR[i]) ** 2, 0) * 14;
    });
    const p = softmax(dists);
    s.probs = Object.fromEntries(SMELL_CLASSES.map((c, i) => [c, Number(p[i].toFixed(3))]));
    const winner = SMELL_CLASSES[p.indexOf(Math.max(...p))];
    const conf = Math.max(...p);
    const deviation = Math.max(...ratios.map((r) => Math.abs(Math.log(r))));

    const meta = scenario && scenario !== "stop" && scenario !== "nominal" ? SCENARIO_META[scenario] : null;
    const isDoor = meta?.cls === "door_open";
    const anomalous = deviation > 0.12 && (winner !== "nominal" || isDoor);
    if (anomalous && s.status !== "anomaly") {
      const kind = isDoor ? "door_open" : winner;
      s.status = "anomaly";
      s.anomaly = { kind, confidence: Number(conf.toFixed(2)), urgency: meta?.urgency ?? "next", since: new Date().toISOString() };
      pushEvent({ sense: "smell", kind, label: `Nose: ${kind.replace(/_/g, " ")}`, detail: `fingerprint ${ratios.map((r) => r.toFixed(2)).join(" / ")} at ${s.location}`, severity: meta?.urgency === "now" ? "alert" : "warn", data: { ratios, probs: s.probs, location: s.location, confidence: conf } });
    } else if (s.status === "anomaly" && s.anomaly) {
      s.anomaly.confidence = Number(conf.toFixed(2));
      if (!isDoor && winner !== "nominal") s.anomaly.kind = winner; // classifier firms up as the fingerprint develops
      if (deviation < 0.06) {
        s.status = "nominal";
        s.anomaly = null;
        pushEvent({ sense: "smell", kind: "voc_clear", label: "VOC cleared", detail: `${s.location} back to baseline`, severity: "info", data: { ratios } });
        if (smellItemId) closeItem(smellItemId, "done", "sous");
        scenarioAnnounced = false;
      }
    }

    if (meta && s.status === "anomaly" && !scenarioAnnounced && deviation > 0.3 * Math.max(...meta.sig.map((v) => Math.abs(Math.log(v))))) {
      scenarioAnnounced = true;
      let auto: Item["auto"] = null;
      if (meta.cls === "spoilage_produce") {
        const avo = state.inventory.find((i) => i.name === "avocado");
        if (avo) avo.freshness = "turning";
        hideItem("m-guac", "Walk-in VOC anomaly; avocado freshness flagged by nose");
        state.metrics.stockouts_prevented += 1;
        state.metrics.est_refunds_avoided_usd += 54;
        state.metrics.est_waste_saved_usd += 38;
        auto = { type: "menu_hide", summary: "Hid Guac & Chips on DoorDash and Uber Eats" };
      } else if (meta.cls === "spoilage_protein") {
        hideItem("m-burger", "Protein spoilage signature in walk-in");
        hideItem("m-chicken", "Protein spoilage signature in walk-in");
        auto = { type: "menu_hide", summary: "Held Smash Burger and Chicken Sandwich" };
      } else if (meta.cls === "oil_degraded") {
        const oil = state.inventory.find((i) => i.name === "fryer oil");
        if (oil) oil.freshness = "turning";
        pushAction({ type: "ask_human", summary: "Fryer oil smells degraded — change before dinner?", payload: { station: "fry-station" }, by: "rules" });
      }
      const urgency: Urgency = meta.urgency === "info" ? "later" : meta.urgency;
      const item = upsertItem({
        title: meta.title,
        detail: meta.detail,
        urgency,
        sense: "smell",
        kind: meta.cls,
        auto,
        evidence: { location: s.location, confidence: Number(conf.toFixed(2)), probs: s.probs, fingerprint: s.fingerprint, ratios, single_channel: false },
        speak: meta.speak,
        location: s.location,
      });
      smellItemId = item.id;
      if (meta.speak) speak(meta.speak);
    }
  }

  // --- orders / inventory -----------------------------------------------------------
  function stepOrders(dtMin: number) {
    const now = state.sim_minutes;
    for (const o of state.orders) {
      if (o.status === "picked_up") continue;
      if (o.dasher_eta_min !== null && o.status !== "ready") o.dasher_eta_min = Math.max(0, o.dasher_eta_min - dtMin);
      if (o.status === "queued" && now >= o.fire_at) o.status = "fire";
      if (o.status === "fire" && now >= o.fire_at + 1.2) o.status = "cooking";
      if (o.status === "cooking" && now >= o.fire_at + o.prep_minutes) {
        o.status = "ready";
        pushEvent({ sense: "orders", kind: "ready", label: `${o.id} ready`, detail: o.items.map((i) => i.name).join(", "), severity: "info", data: { order_id: o.id } });
      }
      if (o.status === "ready" && now >= o.promised_at + 1.5) {
        o.status = "picked_up";
        state.metrics.orders_served += 1;
        pushEvent({ sense: "orders", kind: "picked_up", label: `${o.id} picked up`, detail: o.channel === "walkin" ? "Handed to guest" : "Handed to driver", severity: "info", data: { order_id: o.id } });
      }
      const expectedReady = o.status === "cooking" ? o.fire_at + o.prep_minutes : Math.max(now, o.fire_at) + o.prep_minutes;
      const slack = o.promised_at - expectedReady;
      o.late_risk = o.status === "ready" || o.status === "picked_up" ? "low" : slack < 0 ? "high" : slack < 2 ? "med" : "low";
      if (o.status === "queued" && o.dasher_eta_min !== null && o.dasher_eta_min <= o.prep_minutes + 1 && now < o.fire_at) {
        o.status = "fire";
        o.fire_at = now;
        pushAction({ type: "fire_now", summary: `Fire ${o.id} now — ${o.channel === "doordash" ? "dasher" : "courier"} is ${Math.round(o.dasher_eta_min)} min out`, payload: { order_id: o.id, dasher_eta_min: Math.round(o.dasher_eta_min) }, by: "rules" });
      }
    }
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
      pushEvent({ sense: "orders", kind: "stockout", label: "Stockout forecast", detail: `Avocado hits zero in ~${avo.minutes_to_stockout} min at current burn; 3 queued orders need it`, severity: "warn", data: { ingredient: "avocado", minutes: avo.minutes_to_stockout } });
      hideItem("m-avo-toast", "Avocado forecast to stock out in under 10 min");
      const tt = state.menu.find((m) => m.id === "m-tomato-toast");
      if (tt) {
        tt.substitute_for = "m-avo-toast";
        tt.discount_pct = 15;
        tt.reason = "Promoted while Avocado Toast is unavailable";
        pushAction({ type: "substitute", summary: `Promoting "${tt.name}" in place of Avocado Toast (15% off)`, payload: { menu_id: tt.id, substitute_for: "m-avo-toast", discount_pct: 15 }, by: "rules" });
      }
      state.metrics.stockouts_prevented += 1;
      state.metrics.est_refunds_avoided_usd += 36;
      upsertItem({
        title: "Avocados run out in 8 min — restock or 86",
        detail: "Sous hid Avocado Toast on both apps and is pushing Tomato Toast at 15% off. A reorder draft is waiting for approval.",
        urgency: "next",
        sense: "orders",
        kind: "stockout",
        auto: { type: "menu_hide", summary: "Hid Avocado Toast · promoted Tomato Toast −15%" },
        evidence: { ingredient: "avocado", minutes_to_stockout: avo.minutes_to_stockout, on_hand: avo.on_hand, burn_rate_per_min: Number((avo.burn_rate_per_min * rushMult).toFixed(2)) },
        speak: "Avocados are about to run out. I've hidden Avocado Toast on DoorDash and Uber Eats and I'm pushing the Tomato Toast instead.",
        location: "walk-in",
      });
      speak("Avocados are about to run out. I've hidden Avocado Toast on DoorDash and Uber Eats and I'm pushing the Tomato Toast instead.");
    }
    if (avo && !reorderDrafted && avocadoHidden) {
      reorderDrafted = true;
      pushAction({
        type: "reorder_draft",
        summary: "Reorder draft: 2 cases avocado (48 ea), Sysco, next-morning",
        payload: { supplier: "Sysco", deliver_by: "tomorrow 07:00", lines: [{ name: "avocado", qty: 48, unit: "ea", note: "2 cases, Hass, stage 3 ripeness" }, { name: "tomatoes", qty: 24, unit: "ea", note: "heirloom mix for Tomato Toast demand" }], est_cost_usd: 118.4, status: "draft — needs manager approval" },
        by: "rules",
      });
    }
  }

  // --- ears ---------------------------------------------------------------------------
  function hearingEvent(line: (typeof HEARING_LINES)[number], mic: Mic, how: "zero-shot" | "taught" | "injected") {
    const confidence = Number((how === "injected" ? 1 : 0.55 + Math.random() * 0.4).toFixed(2));
    const db = Number((mic.floor_db + 14 + Math.random() * 12).toFixed(1));
    mic.scores = { ...mic.scores, [line.kind]: Math.min(0.98, 0.45 + Math.random() * 0.4) };
    mic.top = [[line.heard_as, Number((0.4 + Math.random() * 0.4).toFixed(2))], ["Inside, small room", 0.2], ["Speech", 0.12]];
    mic.level_db = db;
    pushEvent({
      sense: "hearing",
      kind: line.kind,
      label: how === "injected" ? `${line.label} (injected)` : line.label,
      detail: line.detail,
      severity: line.severity,
      data: { mic: mic.mic, location: mic.location, how, confidence, heard_as: line.heard_as, db, floor_db: mic.floor_db, top: mic.top, zero_shot: mic.scores, taught: mic.taught },
    });
    upsertItem({
      title: line.title(mic.location),
      detail: line.itemDetail,
      urgency: line.urgency,
      sense: "hearing",
      kind: line.kind,
      auto: line.auto,
      evidence: { mic: mic.mic, location: mic.location, how, confidence, heard_as: line.heard_as, db },
      speak: line.speak,
      location: mic.location,
    });
    if (line.speak && (line.kind !== "ticket_burst" || state.rush)) speak(line.speak);
  }

  function stepEars() {
    const ears = state.senses.ears;
    const h = state.senses.hearing;
    const base = state.rush ? -26 : -36;
    for (const [i, mic] of ears.mics.entries()) {
      mic.windows += 4;
      mic.level_db = Number(Math.max(-60, Math.min(-6, mic.level_db + (base - 4 * i - mic.level_db) * 0.3 + (Math.random() - 0.5) * 6)).toFixed(1));
      mic.floor_db = Number((mic.floor_db + ((mic.level_db - 10) - mic.floor_db) * 0.02).toFixed(1));
      mic.speech_fraction = Number(Math.max(0, Math.min(1, mic.speech_fraction + (Math.random() - 0.5) * 0.06)).toFixed(2));
      for (const k of SCORE_KEYS) {
        const rest = k === "speech" ? mic.speech_fraction : k === "frying" ? 0.15 : 0.04;
        mic.scores[k] = Number(Math.max(0, (mic.scores[k] ?? rest) + (rest - (mic.scores[k] ?? rest)) * 0.35 + (Math.random() - 0.5) * 0.02).toFixed(3));
      }
      if (tick % 5 === i) mic.top = AUDIOSET_IDLE[(tick + i) % AUDIOSET_IDLE.length];
      if (mic.teaching) {
        mic.teaching.remaining_s = Math.max(0, mic.teaching.remaining_s - 1);
        mic.teaching.examples += 2;
        if (mic.teaching.remaining_s === 0) {
          const { label, examples } = mic.teaching;
          const proto = ears.prototypes.find((p) => p.label === label);
          const name = ears.labels.find((l) => l.id === label)?.name ?? label;
          if (proto) proto.examples += examples;
          else ears.prototypes.push({ label, examples, name });
          mic.taught = { ...mic.taught, [label]: 0.97 };
          mic.teaching = null;
          pushEvent({ sense: "hearing", kind: "taught", label: `Learned "${name}"`, detail: `${examples} examples from ${mic.mic} at ${mic.location}`, severity: "info", data: { mic: mic.mic, location: mic.location, label, examples, how: "taught" } });
        }
      }
    }
    h.active = ears.mics.some((m) => m.active);
    h.noise_db = ears.mics[0]?.level_db ?? -60;
    const activeTickets = state.orders.filter((o) => o.status !== "picked_up" && o.status !== "ready").length;
    const target = Math.min(1, 0.15 + activeTickets * 0.06 + (h.noise_db + 40) / 80);
    h.stress = Number((h.stress + (target - h.stress) * 0.2).toFixed(2));

    sinceHearing += 1;
    const gap = state.rush ? 3 : 5;
    if (sinceHearing >= gap + rnd(2) && ears.mics.length) {
      sinceHearing = 0;
      const pick = HEARING_LINES[Math.floor(Math.random() * HEARING_LINES.length)];
      const mic = pick.kind === "door_chime" || pick.kind === "phone_ring" ? ears.mics[ears.mics.length - 1] : ears.mics[0];
      const taught = ears.prototypes.some((p) => p.label === pick.kind);
      hearingEvent(pick, mic, taught ? "taught" : "zero-shot");
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
    const dtMin = 0.35 * speed;
    state.sim_minutes = Number((state.sim_minutes + dtMin).toFixed(2));
    state.clock = new Date().toISOString();
    state.speed = speed;
    if (tick === 15 && scenario === null && state.senses.smell.scenario === null) startScenario("spoilage_walkin");
    if (tick === 3) pushEvent({ sense: "smell", kind: "device_connected", label: "Replay source connected", detail: "No board on serial/http — replaying synthetic sweeps via POST /api/sensor/reading", severity: "info", data: { device: "replay", sensor_id: "sim-bme688" } });
    if (tick === 2) speak("Sous is online. Two mics listening, nose calibrated — four tickets on the board, walk-in reads nominal.");
    stepSmell();
    stepOrders(dtMin);
    stepInventory(dtMin);
    stepEars();
    maybeNewOrder();
    expireItems();
    emit({ type: "snapshot", state: snapshot() });
  }

  function snapshot(): State {
    const s = state.senses.smell;
    return {
      ...state,
      orders: state.orders.map((o) => ({ ...o, items: [...o.items] })),
      inventory: state.inventory.map((i) => ({ ...i })),
      menu: state.menu.map((m) => ({ ...m })),
      senses: {
        hearing: { ...state.senses.hearing, recent: [...state.senses.hearing.recent] },
        ears: { ...state.senses.ears, mics: state.senses.ears.mics.map((m) => ({ ...m, scores: { ...m.scores }, top: m.top.map((t) => [...t] as [string, number]), taught: { ...m.taught }, teaching: m.teaching ? { ...m.teaching } : null })), prototypes: state.senses.ears.prototypes.map((p) => ({ ...p })) },
        smell: { ...s, trace: [...s.trace], ratios: s.ratios ? [...s.ratios] : null, probs: s.probs ? { ...s.probs } : null, anomaly: s.anomaly ? { ...s.anomaly } : null, calibration: { ...s.calibration } },
      },
      items: { ...state.items, open: state.items.open.map((i) => ({ ...i })), recent_closed: state.items.recent_closed.map((i) => ({ ...i })), counts: { ...state.items.counts } } as Items,
      voice: { ...state.voice },
      actions: [...state.actions],
      metrics: { ...state.metrics },
      providers: { ...state.providers },
    };
  }

  const api: SousApi = {
    health: async () => ({ ok: true, providers: state.providers, smell_device: state.senses.smell.device, mics: state.senses.ears.mics.length }),
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
      smellItemId = null;
      orderSeq = { doordash: 104, ubereats: 33, phone: 7, walkin: 12 };
      const muted = state.voice.muted;
      const prototypes = state.senses.ears.prototypes; // reset keeps ear calibration
      state = fresh();
      state.voice.muted = muted;
      state.senses.ears.prototypes = prototypes;
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
        const it = state.items.open.find((i) => i.kind === "stockout");
        if (it) closeItem(it.id, "done", "owner");
      }
      emit({ type: "snapshot", state: snapshot() });
    },
    getItems: async () => snapshot().items,
    itemDone: async (id) => closeItem(id, "done", "owner"),
    itemDismiss: async (id) => closeItem(id, "dismissed", "owner"),
    smellScenario: async (name) => {
      startScenario(name);
      pushEvent({ sense: "smell", kind: "device_connected", label: `Scenario: ${name}`, detail: "Replaying heater sweeps through POST /api/sensor/reading", severity: "info", data: { scenario: name } });
    },
    sensorReading: async (body) => {
      const s = state.senses.smell;
      s.device = "http";
      s.sensor_id = body.sensor_id;
      s.location = body.location;
      if (typeof body.temp_c === "number") s.temp_c = body.temp_c;
      if (typeof body.rh === "number") s.rh = body.rh;
    },
    earTeach: async ({ label, mic, seconds = 4 }) => {
      const target = state.senses.ears.mics.find((m) => m.mic === mic) ?? state.senses.ears.mics[0];
      if (!target) throw new Error("no mic connected");
      if (!state.senses.ears.labels.some((l) => l.id === label)) throw new Error(`unknown label ${label}`);
      target.teaching = { label, remaining_s: seconds, examples: 0 };
      emit({ type: "snapshot", state: snapshot() });
    },
    earPrototypes: async () => ({ prototypes: state.senses.ears.prototypes.map((p) => ({ ...p })) }),
    earForget: async (label) => {
      state.senses.ears.prototypes = state.senses.ears.prototypes.filter((p) => p.label !== label);
      for (const m of state.senses.ears.mics) delete m.taught[label];
      emit({ type: "snapshot", state: snapshot() });
    },
    hearingInject: async (kind, location) => {
      const line = HEARING_LINES.find((l) => l.kind === kind) ?? HEARING_LINES[0];
      const mic = state.senses.ears.mics.find((m) => m.location === location) ?? state.senses.ears.mics[0] ?? mkMic("inject", location ?? "kitchen", "mic");
      hearingEvent(line, mic, "injected");
    },
    sounds: async () => ({ clips: SOUND_CLIPS.map((c) => ({ ...c })) }),
    hosts: async () => ({ port: Number(window.location.port) || 80, hosts: [] }), // mock: no LAN discovery; the page falls back to window.location
    speak: async () => null, // mock has no TTS provider -> lines are shown, not spoken
    // The scent room needs the real nose pipeline; the mock does not simulate it.
    room: async () => {
      throw new Error("scent room needs the backend");
    },
    roomAdd: async () => {
      throw new Error("scent room needs the backend");
    },
    roomMove: async () => {
      throw new Error("scent room needs the backend");
    },
    roomRemove: async () => undefined,
    roomReset: async () => undefined,
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
