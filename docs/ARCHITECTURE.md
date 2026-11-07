# Sous architecture (v2)

Three sensing subsystems, one decision system, one voice. Each subsystem is independently
testable and has its own page in the dashboard; the Board page is where they meet.

```
                 ┌──────────────── senses ────────────────┐
  phones/laptop  │ EARS   mic audio → YAMNet embedding →   │
  microphones ──►│        zero-shot + few-shot k-NN →      │──► hearing events (kind, location, confidence, evidence)
                 │        merge/hold/burst                 │
                 ├─────────────────────────────────────────┤
  BME688 board / │ NOSE   heater-sweep resistances →       │
  serial bridge /│        self-calibration (baseline, RH   │──► smell events (class, urgency, probs, fingerprint)
  simulator ────►│        slope, drift) → fingerprint      │
                 │        features → GBDT classifier        │
                 ├─────────────────────────────────────────┤
  DoorDash/POS   │ ORDERS order stream → recipe-level      │
  (simulated) ──►│        inventory → burn rate →          │──► stockout predictions
                 │        minutes-to-stockout              │
                 └─────────────────────────────────────────┘
                                     │
                                     ▼
                 ┌──────────────── agent ─────────────────┐
                 │ rules: signal → ONE action item         │
                 │   urgency now/next/today/later          │
                 │   dedupe (key + count), auto-expire,    │
                 │   auto-resolve when the world confirms  │
                 │ auto-actions: storefront hide/promote,  │
                 │   reorder drafts, board additions       │
                 │ voice: speaks "now" items, rate-limited │
                 │ LLM (optional): phrasing, ambiguity     │
                 └─────────────────────────────────────────┘
                                     │
                         ┌───────────┴────────────┐
                         ▼                        ▼
                 Board / Ears / Nose /      ElevenLabs voice
                 Kitchen / Storefront       (cached clips, or live with a key)
```

## Ears (`backend/sous/senses/ear/`)
* `embedder.py` loads YAMNet once (TF Hub), 7 ms per 1 s window on CPU.
* `classifier.py` per-mic pipeline: noise floor → AGC → spectral gate → embedding → zero-shot
  prior + few-shot k-NN over taught prototypes (plus an auto-collected background class) →
  continuation merge, hold, burst count. Tunables in `CFG`; `tests/sweep_ear.py` sweeps them.
* `streams.py` multi-mic manager; `/ws/audio?mic=&location=` per device. One shared prototype
  store (`data/ear_prototypes.json`) so calibration survives restarts and spans mics.
* `sounds.py` the realistic test clips (ElevenLabs text-to-sound) served to the phone Sound Board
  and composed into the 78 s evaluation soundtrack. See `docs/EARS.md` for measured numbers.

## Nose (`backend/sous/senses/nose/`)
* `physics.py` MOX response model with 4 heater steps and per-gas sensitivity fingerprints
  (reducing gases lower resistance, oxidising cleaners raise it), kinetics per scenario,
  sensor gain variation, drift, noise, humidity cross-sensitivity, nuisance events (door open,
  breath). Generates training windows and drives the live replay.
* `calibration.py` baseline per step from warm-up, slow adaptation only while nominal, online
  humidity-slope fit, drift estimate, a 0–1 calibration quality score.
* `features.py` 30 s window → ratios per step, fingerprint shape, rise rates, magnitude, duration
  above threshold, temperature and humidity deltas.
* `model.py` gradient-boosted trees trained on synthetic windows, saved to `data/nose_model.joblib`;
  `unknown` when confidence is low. Trains in well under a minute on CPU.
* `pipeline.py` ingest (4-step or legacy single channel) → calibrate → features → classify →
  hysteresis → events with urgency. The HTTP endpoint, the serial bridge and the simulator all
  call the same `ingest`. See `docs/ENOSE.md`.

## Orders (`backend/sous/sim/`)
Poisson arrivals over four channels, per-channel item popularity, Dasher ETAs, just-in-time fire
times, a capped kitchen-load model, recipe-level inventory decrement on fire, trailing-window
burn rate with a time-based EMA, minutes-to-stockout. Stands in for the DoorDash order webhook
and the POS.

## Agent (`backend/sous/agent/`)
* `items.py` the action-item store: add-or-update by key, urgency buckets, auto-expire,
  auto-resolve, JSON persistence, snapshot (open sorted by urgency then age).
* `brain.py` maps events to items and auto-actions. Hearing: printer → heard order on the board;
  fryer alarm → "fries up for X" or "check station 2"; door chime → "hand X to the Dasher" /
  "tell them X is N min out" / "someone at the door"; phone → pick up; clatter → check breakage.
  Smell: produce turning → discount + skip reorder; protein → human check (no auto-action on
  food safety); burning → now; oil → change before rush + reorder; cleaning/door → info;
  unknown → ask. Orders: predicted stockout → pull dishes, promote substitute, draft reorder,
  item "approve the reorder". Items close themselves when the Dasher leaves, the air clears, or
  stock comes back.
* `tts.py` ElevenLabs voice: pre-rendered clips for every fixed line (`backend/voice_cache/`),
  live synthesis with a key, browser fallback otherwise. Dynamic fire calls are display-only
  unless a key is set, so the voice never mixes.
* `llm.py` optional Anthropic / Nova SDK phrasing with a hard timeout and rules fallback.

## API (`backend/sous/api.py`)
FastAPI hub: 10 Hz world tick, 1 Hz nose/ears/items tick and state snapshot over `/ws`, immediate
`event` / `action` / `item` / `speak` messages, REST for controls, items, teaching, scenarios,
sensor ingest, sounds. Full schema in `CONTRACT.md`.

## Frontend (`frontend/`)
Vite + React + Tailwind. Board (items Now/Next/Today + voice + sense strip), Ears (mics, teach,
prototypes, events, soundtrack truth-vs-detected), Nose (fingerprint, probabilities, calibration,
trace, simulator), Kitchen (orders + inventory), Storefront (customer menu), Sounds (phone sound
board with "heard it" feedback).

## Hardware (`firmware/`, `tools/`)
ESP32 + BME688 sketch (posts 1 Hz JSON), Arduino + MQ-135 sketch, serial bridge, BOM. Not run
on hardware; the replay path exercises the identical endpoint.
