// Mirrors /home/exedev/sous/CONTRACT.md (v2) exactly. Legacy v1 fields that the current
// backend still emits are kept as optional so a v1 snapshot normalises cleanly (see lib/normalise.ts).

export type Channel = "doordash" | "ubereats" | "phone" | "walkin";
export type OrderStatus = "queued" | "fire" | "cooking" | "ready" | "picked_up";
export type LateRisk = "low" | "med" | "high";

export type Order = {
  id: string;
  channel: Channel;
  items: { name: string; qty: number }[];
  placed_at: number;
  promised_at: number;
  fire_at: number;
  prep_minutes: number;
  status: OrderStatus;
  dasher_eta_min: number | null;
  late_risk: LateRisk;
};

export type Freshness = "fresh" | "watch" | "turning" | "spoiled";
export type Location = "walk-in" | "line" | "dry" | "fry-station";

export type Ingredient = {
  name: string;
  label?: string;
  unit: string;
  on_hand: number;
  par: number;
  burn_rate_per_min: number;
  minutes_to_stockout: number | null;
  freshness: Freshness;
  days_in_stock: number;
  location: Location;
};

export type MenuItem = {
  id: string;
  name: string;
  emoji?: string;
  price: number;
  available: boolean;
  discount_pct: number;
  reason: string | null;
  substitute_for: string | null;
  ingredients: { name: string; label?: string; qty: number }[];
  tags: string[];
};

export type Metrics = {
  orders_served: number;
  stockouts_prevented: number;
  est_refunds_avoided_usd: number;
  est_waste_saved_usd: number;
};

// --- senses ------------------------------------------------------------------

export type Sense = "hearing" | "smell" | "orders" | "agent";
export type Severity = "info" | "warn" | "alert";

export type Event = {
  id: string;
  t: string;
  sense: Sense;
  kind: string;
  label: string;
  detail: string;
  severity: Severity;
  data: Record<string, unknown>;
};

export type ActionType = "menu_hide" | "menu_restore" | "menu_discount" | "substitute" | "reorder_draft" | "fire_now" | "ask_human" | "speak" | (string & {});

export type Action = {
  id: string;
  t: string;
  type: ActionType;
  summary: string;
  payload: Record<string, unknown>;
  by: "rules" | "llm";
};

export type EarModel = "yamnet" | "loading" | "dsp-fallback";

export type Mic = {
  mic: string;
  location: string; // "kitchen" | "front" | "pass" | free text
  source: "mic" | "soundtrack";
  model: EarModel;
  level_db: number;
  floor_db: number;
  active: boolean;
  speech_fraction: number;
  /** zero-shot kitchen-event scores: fryer_alarm, door_chime, ticket_burst, clatter, phone_ring, speech, frying */
  scores: Record<string, number>;
  /** top-3 AudioSet classes */
  top: [string, number][];
  /** cosine similarity to nearest prototype per taught label (+ "_background") */
  taught: Record<string, number>;
  teaching: { label: string; remaining_s: number; examples: number } | null;
  windows: number;
};

export type Ears = {
  active: boolean;
  model: EarModel | "idle";
  mics: Mic[];
  prototypes: { label: string; examples: number; name: string }[]; // includes "_background" = "Room background"
  labels: { id: string; name: string }[]; // teachable labels
};

export type Hearing = {
  active: boolean;
  source: "mic" | "soundtrack" | "none";
  noise_db: number;
  stress: number;
  recent: Event[];
};

export type SmellDevice = "none" | "serial" | "http" | "replay";
export type SmellStatus = "offline" | "warming" | "calibrating" | "nominal" | "anomaly";
export type Urgency = "now" | "next" | "today" | "later";
export type SmellUrgency = "now" | "next" | "today" | "info";

export type SmellCalibration = {
  status: string;
  quality: number;
  baseline_ohm: number[] | null;
  rh_slope: number | null;
  samples: number;
  [k: string]: unknown;
};

export type Smell = {
  device: SmellDevice;
  sensor_id: string;
  location: string;
  status: SmellStatus;
  calibration: SmellCalibration;
  /** 4 heater steps, baseline/gas, 1.0 = clean air */
  ratios: number[] | null;
  /** log-ratios normalised by step 2 (3 values) or 4 values */
  fingerprint: number[] | null;
  /** nominal, spoilage_produce, spoilage_protein, burning, oil_degraded, cleaning */
  probs: Record<string, number> | null;
  anomaly: { kind: string; confidence: number; urgency: SmellUrgency; since: string } | null;
  scenario: string | null;
  /** last 180 s */
  trace: { t: number; ratio: number; ratios?: number[] }[];
  model: { name: string; features: number; trained_on: number; accuracy: number };
  single_channel?: boolean;
  // legacy v1 fields (still emitted by the v1 backend)
  baseline_ohm?: number | null;
  gas_ohm?: number | null;
  ratio?: number | null;
  temp_c?: number | null;
  rh?: number | null;
};

// --- items -------------------------------------------------------------------

export type ItemSense = "hearing" | "smell" | "orders";
export type ItemStatus = "open" | "done" | "dismissed" | "expired";

export type Item = {
  id: string;
  created: string;
  updated: string;
  /** imperative, <= 70 chars */
  title: string;
  /** one or two sentences of why / what Sous did */
  detail: string;
  urgency: Urgency;
  sense: ItemSense;
  kind: string;
  status: ItemStatus;
  /** repeats merged into this item */
  count: number;
  /** what Sous already did */
  auto: { type: string; summary: string } | null;
  /** hearing: mic, location, how (taught|zero-shot|injected), confidence, heard_as, db, order_id
   *  smell: location, confidence, probs, fingerprint, single_channel
   *  orders: ingredient, minutes_to_stockout, on_hand, burn_rate_per_min */
  evidence: Record<string, unknown>;
  speak: string | null;
  location: string | null;
  closed?: string;
  closed_by?: "owner" | "sous" | "timeout";
};

export type Items = {
  open: Item[];
  recent_closed: Item[];
  counts: { now: number; next: number; today: number; later: number };
  total_created: number;
};

export type Providers = {
  llm: "anthropic" | "nova" | "rules";
  tts: "elevenlabs" | "cache" | "browser" | (string & {});
  ears: "ready" | "loading" | "unavailable" | "unloaded";
  nose: string;
};

export type State = {
  clock: string;
  sim_minutes: number;
  rush: boolean;
  speed: number;
  orders: Order[];
  inventory: Ingredient[];
  menu: MenuItem[];
  metrics: Metrics;
  senses: {
    /** legacy summary */
    hearing: Hearing;
    ears: Ears;
    smell: Smell;
  };
  items: Items;
  voice: { last_line: string; muted: boolean };
  actions: Action[];
  providers: Providers;
};

export type ItemChange = "added" | "updated" | "closed";

export type WsMessage =
  | { type: "snapshot"; state: State }
  | { type: "event"; event: Event }
  | { type: "action"; action: Action }
  | { type: "item"; change: ItemChange; item: Item }
  | { type: "speak"; text: string; id: string };

// --- REST bodies ---------------------------------------------------------------

export type SmellScenario = "spoilage_walkin" | "spoilage_protein" | "fryer_oil" | "burning" | "cleaning" | "door_open" | "nominal" | "stop";
export type HearingInjectKind = "ticket_burst" | "fryer_alarm" | "door_chime" | "phone_ring" | "clatter";
export type ControlBody = { rush?: boolean; muted?: boolean; speed?: number };

export type SensorReadingBody = {
  sensor_id: string;
  location: string;
  gas_ohm?: number;
  gas_ohm_steps?: number[];
  temp_c?: number;
  rh?: number;
  pressure_hpa?: number;
  t?: number;
};

export type SoundClip = { id: string; name: string; kind: string; emoji: string; hint: string; available: boolean; url: string };

export type HostsResponse = { port: number; hosts: { ip: string; url: string }[] };

export type SoundtrackTruth = {
  duration_s?: number;
  events: { t: number; kind: string; clip?: string; label?: string }[];
};

export type ConnectionStatus = "connecting" | "open" | "closed" | "mock";
