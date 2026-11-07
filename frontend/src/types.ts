// Mirrors /home/exedev/sous/CONTRACT.md exactly.

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
  /** Human-readable name, e.g. "salsa verde". Optional for older backends. */
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
  /** Single emoji used as the card art, e.g. "🥑". Optional for older backends. */
  emoji?: string;
  price: number;
  available: boolean;
  discount_pct: number;
  reason: string | null;
  substitute_for: string | null;
  ingredients: { name: string; label?: string; qty: number }[];
  tags: string[];
};

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

export type ActionType =
  | "menu_hide"
  | "menu_restore"
  | "menu_discount"
  | "substitute"
  | "reorder_draft"
  | "fire_now"
  | "ask_human"
  | "speak";

export type Action = {
  id: string;
  t: string;
  type: ActionType;
  summary: string;
  payload: Record<string, unknown>;
  by: "rules" | "llm";
};

export type SmellDevice = "none" | "serial" | "http" | "replay";
export type SmellStatus = "offline" | "warming" | "nominal" | "anomaly";
export type AnomalyKind = "spoilage" | "burning" | "oil_degraded" | "cleaning" | "unknown";

export type State = {
  clock: string;
  sim_minutes: number;
  rush: boolean;
  orders: Order[];
  inventory: Ingredient[];
  menu: MenuItem[];
  senses: {
    hearing: {
      active: boolean;
      source: "mic" | "soundtrack" | "none";
      noise_db: number;
      stress: number;
      recent: Event[];
    };
    smell: {
      device: SmellDevice;
      sensor_id: string;
      location: string;
      baseline_ohm: number | null;
      gas_ohm: number | null;
      ratio: number | null;
      temp_c: number | null;
      rh: number | null;
      status: SmellStatus;
      anomaly: { kind: AnomalyKind; magnitude: number; since: string } | null;
      scenario: string | null;
      trace: { t: number; ratio: number }[];
    };
  };
  voice: { last_line: string; muted: boolean };
  actions: Action[];
  metrics: {
    orders_served: number;
    stockouts_prevented: number;
    est_refunds_avoided_usd: number;
    est_waste_saved_usd: number;
  };
  providers: { llm: "anthropic" | "nova" | "rules"; tts: "elevenlabs" | "hume" | "browser" };
};

export type WsMessage =
  | { type: "snapshot"; state: State }
  | { type: "event"; event: Event }
  | { type: "action"; action: Action }
  | { type: "speak"; text: string; id: string };

export type SmellScenario = "spoilage_walkin" | "fryer_oil" | "burning" | "cleaning" | "nominal" | "stop";
export type HearingInjectKind = "ticket_burst" | "fryer_alarm" | "door_chime";

export type ControlBody = { rush?: boolean; muted?: boolean; speed?: number };

export type SoundtrackTruth = {
  duration_s?: number;
  events: { t: number; kind: string; label?: string }[];
};

export type ConnectionStatus = "connecting" | "open" | "closed" | "mock";
