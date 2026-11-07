# Sous — backend/frontend contract (v2)

Sous is a multisensory kitchen agent. **Ears** (microphones → kitchen sound events via a small
embedding model with few-shot calibration), **Nose** (VOC gas sensor heater-sweep fingerprint →
smell class with urgency), **Orders** (recipe-level inventory → stockout prediction). The **agent**
turns every signal into a prioritised **action item** and acts on the storefront. One voice.

Backend: FastAPI on `http://localhost:8000`, serves `frontend/dist`. Dev: Vite on `:5173` proxies `/api` and `/ws`.

## WebSocket `/ws` (server → client)

```jsonc
{ "type": "snapshot", "state": State }                 // on connect, then every 1s
{ "type": "event",    "event": Event }                 // immediately
{ "type": "action",   "action": Action }               // immediately
{ "type": "item",     "change": "added"|"updated"|"closed", "item": Item }
{ "type": "speak",    "text": "…", "id": "…" }          // client plays /api/speak audio or speechSynthesis
```

## State

```ts
type State = {
  clock: string; sim_minutes: number; rush: boolean; speed: number;
  orders: Order[]; inventory: Ingredient[]; menu: MenuItem[]; metrics: Metrics;   // unchanged from v1
  senses: {
    hearing: { active: boolean; source: "mic"|"none"; noise_db: number; stress: number; recent: Event[] }; // legacy summary
    ears: {
      active: boolean;
      model: "yamnet" | "loading" | "dsp-fallback" | "idle";
      mics: Mic[];
      prototypes: { label: string; examples: number; name: string }[];   // includes "_background" = "Room background"
      labels: { id: string; name: string }[];                            // teachable labels
    };
    smell: Smell;
  };
  items: { open: Item[]; recent_closed: Item[]; counts: { now: number; next: number; today: number; later: number }; total_created: number };
  voice: { last_line: string; muted: boolean };
  actions: Action[];
  providers: { llm: "anthropic"|"nova"|"rules"; tts: "elevenlabs"|"cache"|"browser"; ears: "ready"|"loading"|"unavailable"|"unloaded"; nose: string };
};

type Mic = {
  mic: string; location: string;            // "kitchen" | "front" | "pass" | free text
  source: "mic" | "soundtrack";
  model: "yamnet" | "loading" | "dsp-fallback";
  level_db: number; floor_db: number; active: boolean; speech_fraction: number;
  scores: Record<string, number>;           // zero-shot kitchen-event scores (fryer_alarm, door_chime, ticket_burst, clatter, phone_ring, speech, frying)
  top: [string, number][];                  // top-3 AudioSet classes
  taught: Record<string, number>;           // cosine similarity to nearest prototype per taught label (+ "_background")
  teaching: { label: string; remaining_s: number; examples: number } | null;
  windows: number;
};

type Smell = {
  device: "none" | "serial" | "http" | "replay";
  sensor_id: string; location: string;
  status: "offline" | "warming" | "calibrating" | "nominal" | "anomaly";
  calibration: { status: string; quality: number; baseline_ohm: number[] | null; rh_slope: number | null; samples: number; [k: string]: unknown };
  ratios: number[] | null;                  // 4 heater steps, baseline/gas, 1.0 = clean air
  fingerprint: number[] | null;             // shape: log-ratios normalised by step 2 (3 values) or 4 values
  probs: Record<string, number> | null;     // nominal, spoilage_produce, spoilage_protein, burning, oil_degraded, cleaning
  anomaly: { kind: string; confidence: number; urgency: "now"|"next"|"today"|"info"; since: string } | null;
  scenario: string | null;
  trace: { t: number; ratio: number; ratios?: number[] }[];   // last 180 s
  model: { name: string; features: number; trained_on: number; accuracy: number };
  single_channel?: boolean;
};

type Item = {
  id: string; created: string; updated: string;
  title: string;                            // imperative, ≤ 70 chars
  detail: string;                           // one or two sentences of why / what Sous did
  urgency: "now" | "next" | "today" | "later";
  sense: "hearing" | "smell" | "orders";
  kind: string;                             // e.g. fryer_alarm, door_chime, ticket_burst, phone_ring, clatter, spoilage_produce, burning, oil_degraded, cleaning, unknown, stockout
  status: "open" | "done" | "dismissed" | "expired";
  count: number;                            // repeats merged into this item
  auto: { type: string; summary: string } | null;   // what Sous already did
  evidence: Record<string, unknown>;        // hearing: mic, location, how (taught|zero-shot|injected), confidence, heard_as, db, order_id
                                            // smell: location, confidence, probs, fingerprint, single_channel
                                            // orders: ingredient, minutes_to_stockout, on_hand, burn_rate_per_min
  speak: string | null; location: string | null;
  closed?: string; closed_by?: "owner" | "sous" | "timeout";
};

type Event = { id: string; t: string; sense: "hearing"|"smell"|"orders"|"agent"; kind: string; label: string; detail: string;
               severity: "info"|"warn"|"alert"; data: Record<string, unknown> };
// hearing event.data: mic, location, how, confidence, db, floor_db, burst_30s, top: [name, score][], zero_shot: {...}, taught: {...}
// hearing kinds: fryer_alarm | door_chime | ticket_burst | clatter | phone_ring | taught | mic_online | mic_offline
// smell kinds: nominal→(none) | spoilage_produce | spoilage_protein | burning | oil_degraded | cleaning | door_open | unknown | voc_clear | device_connected | relocated
type Action = { id: string; t: string; type: string; summary: string; payload: Record<string, unknown>; by: "rules"|"llm" };
```

## REST

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/health` | | ok, providers, smell_device, mics |
| GET | `/api/state` | | State |
| POST | `/api/control` | `{rush?, muted?, speed?}` | |
| POST | `/api/reset` | | reset sim + items (keeps ear calibration) |
| POST | `/api/menu/{id}/restore` | | staff override "we got more" |
| GET | `/api/items` | | items snapshot |
| POST | `/api/items/{id}/done` · `/dismiss` | | owner closes an item |
| POST | `/api/smell/scenario` | `{name}` | simulator: spoilage_walkin, spoilage_protein, fryer_oil, burning, cleaning, door_open, nominal, stop |
| POST | `/api/sensor/reading` | `{sensor_id, location, gas_ohm?, gas_ohm_steps?[4], temp_c?, rh?, pressure_hpa?, t?}` | hardware endpoint (ESP32 / serial bridge / replay) |
| POST | `/api/ear/teach` | `{label, mic?, seconds?=4}` | start few-shot teaching on a mic (default: first mic). label ∈ ears.labels |
| GET | `/api/ear/prototypes` | | `{prototypes:[...]}` |
| DELETE | `/api/ear/prototypes/{label}` | | forget a taught label |
| POST | `/api/hearing/inject` | `{kind, location?}` | scripted fallback |
| GET | `/api/sounds` | | `{clips:[{id,name,kind,emoji,hint,available,url}]}` for the Sound Board |
| GET | `/api/sounds/{id}.wav` | | clip audio |
| GET | `/api/demo/soundtrack.wav` · `.json` | | 78 s sequence built from the real clips + ground truth `{events:[{t,kind,clip}]}` |
| POST | `/api/speak` | `{text}` | audio/mpeg or 204 |

## WebSocket `/ws/audio?mic=<id>&location=<loc>&source=mic|soundtrack` (client → server)

Binary frames: Int16 LE mono 16 kHz, ~250 ms each. Optional text frame `{"location":"front"}` to re-label.
Any number of devices may connect (a laptop and two phones = three mics). Mic id should be stable per device (store in localStorage).

## Views (v2)

Tabs: **Board** (default) · **Ears** · **Nose** · **Kitchen** · **Storefront** · **Sounds** (phone page).
