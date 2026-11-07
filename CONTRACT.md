# Sous — backend/frontend contract

Sous is a multisensory kitchen agent: **ears** (microphone → kitchen events), **nose** (VOC gas sensor →
freshness / burning / oil degradation), and the **order stream** (recipe-level inventory → stockout
prediction → acts on the storefront). One voice speaks to the line.

Backend: FastAPI on `http://localhost:8000`. Frontend: Vite dev server on `:5173`, proxies `/api` and `/ws`.

## WebSocket `/ws` (server → client, JSON text frames)

```jsonc
{ "type": "snapshot", "state": State }     // on connect, then every 1s
{ "type": "event",    "event": Event }     // immediately when something happens
{ "type": "action",   "action": Action }   // immediately when the agent acts
{ "type": "speak",    "text": "…", "id": "…" }  // the voice line; client speaks it (speechSynthesis) unless /api/speak returns audio
```

### State
```ts
type State = {
  clock: string;              // ISO wall clock
  sim_minutes: number;        // simulated minutes since open
  rush: boolean;
  orders: Order[];            // active + last few completed, newest first, max 24
  inventory: Ingredient[];
  menu: MenuItem[];
  senses: {
    hearing: {
      active: boolean;
      source: "mic" | "soundtrack" | "none";
      noise_db: number;       // relative dBFS, -60..0
      stress: number;         // 0..1 fused from noise + ticket rate
      recent: Event[];        // last 10 hearing events
    };
    smell: {
      device: "none" | "serial" | "http" | "replay";
      sensor_id: string; location: string;   // e.g. "walk-in", "fry-station"
      baseline_ohm: number | null; gas_ohm: number | null;
      ratio: number | null;   // baseline_ohm / gas_ohm; >1 means more VOCs than baseline
      temp_c: number | null; rh: number | null;
      status: "offline" | "warming" | "nominal" | "anomaly";
      anomaly: { kind: "spoilage" | "burning" | "oil_degraded" | "cleaning" | "unknown"; magnitude: number; since: string } | null;
      scenario: string | null;              // active simulator scenario name, or null
      trace: { t: number; ratio: number }[]; // last 180 samples (1 Hz), t = seconds
    };
  };
  voice: { last_line: string; muted: boolean };
  actions: Action[];          // last 30, newest first
  metrics: {
    orders_served: number;
    stockouts_prevented: number;
    est_refunds_avoided_usd: number;
    est_waste_saved_usd: number;
  };
  providers: { llm: "anthropic" | "nova" | "rules"; tts: "elevenlabs" | "hume" | "browser" };
};

type Order = {
  id: string;                 // "D-104", "U-33", "P-7", "W-12"
  channel: "doordash" | "ubereats" | "phone" | "walkin";
  items: { name: string; qty: number }[];
  placed_at: number;          // sim_minutes
  promised_at: number;        // sim_minutes the food should be ready
  fire_at: number;            // agent's recommended start time (sim_minutes)
  prep_minutes: number;
  status: "queued" | "fire" | "cooking" | "ready" | "picked_up";
  dasher_eta_min: number | null;
  late_risk: "low" | "med" | "high";
};

type Ingredient = {
  name: string; unit: string;
  on_hand: number; par: number;
  burn_rate_per_min: number;
  minutes_to_stockout: number | null;
  freshness: "fresh" | "watch" | "turning" | "spoiled";
  days_in_stock: number;
  location: "walk-in" | "line" | "dry" | "fry-station";
};

type MenuItem = {
  id: string; name: string; price: number;
  available: boolean;
  discount_pct: number;       // 0 if none
  reason: string | null;      // why hidden/discounted, shown in storefront as tooltip
  substitute_for: string | null; // menu id this is being promoted in place of
  ingredients: { name: string; qty: number }[];
  tags: string[];
};

type Event = {
  id: string; t: string;
  sense: "hearing" | "smell" | "orders" | "agent";
  kind: string;               // hearing: ticket_burst | fryer_alarm | door_chime | speech | noise_spike
                              // smell: voc_rise | voc_clear | spoilage | burning | oil_degraded | cleaning | device_connected
                              // orders: placed | ready | picked_up | late
                              // agent: decision
  label: string; detail: string;
  severity: "info" | "warn" | "alert";
  data: Record<string, unknown>;
};

type Action = {
  id: string; t: string;
  type: "menu_hide" | "menu_restore" | "menu_discount" | "substitute" | "reorder_draft" | "fire_now" | "ask_human" | "speak";
  summary: string;
  payload: Record<string, unknown>;
  by: "rules" | "llm";
};
```

## REST (client → server)

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/health` | | `{ ok, providers, smell_device }` |
| GET | `/api/state` | | current `State` |
| POST | `/api/control` | `{ rush?: boolean, muted?: boolean, speed?: number }` | toggle rush, mute voice, sim speed multiplier |
| POST | `/api/reset` | | reset the simulation |
| POST | `/api/menu/{id}/restore` | | human override: "we got avocados", restores item |
| POST | `/api/smell/scenario` | `{ name: "spoilage_walkin" \| "fryer_oil" \| "burning" \| "cleaning" \| "nominal" \| "stop" }` | drive the sensor simulator; replays through the hardware endpoint |
| POST | `/api/sensor/reading` | `{ sensor_id, location, gas_ohm, temp_c, rh, pressure_hpa?, t? }` | **hardware endpoint** — what the ESP32 posts. The replay uses the exact same path. |
| POST | `/api/hearing/inject` | `{ kind: "ticket_burst" \| "fryer_alarm" \| "door_chime" }` | scripted fallback if the room is too loud |
| GET | `/api/demo/soundtrack.wav` | | generated 75 s kitchen soundtrack with known events |
| GET | `/api/demo/soundtrack.json` | | ground-truth event timestamps in that soundtrack |
| POST | `/api/speak` | `{ text }` | returns `audio/mpeg` if a TTS provider is configured, else `204` (client uses speechSynthesis) |

## WebSocket `/ws/audio` (client → server)

- First frame, text: `{"source": "mic" | "soundtrack", "sample_rate": 16000}`
- Then binary frames: Int16 little-endian mono PCM, ~250 ms per frame.
- Server runs the DSP classifier and emits hearing `Event`s on `/ws`.

## Frontend views

Tabs: **Kitchen** (line display: orders with fire timing, live event feed, voice transcript),
**Storefront** (customer-side menu that changes live), **Back Office** (inventory forecast, nose trace,
actions, reorder draft), **Senses** (hardware panel: pipeline diagram, device status, firmware, scenario buttons).
Persistent control bar: Rush toggle, Mic, Play soundtrack, Smell scenario, Mute, Reset.
