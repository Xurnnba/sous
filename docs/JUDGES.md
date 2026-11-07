# For judges: what is real, what is simulated, what is mocked

We would rather you know exactly where the seams are than discover one yourself.

## Real: code that runs and does the work

| Component | Where | What it does |
|---|---|---|
| Ears: audio classifier | `backend/sous/senses/hearing.py` | 16 kHz PCM from a browser microphone (or the soundtrack) → 25 ms frame features (RMS, FFT peak, prominence, spectral flatness) → rules with debouncing → ticket-printer, fryer-alarm, door-chime, clatter events. Tested at 12/12 recall, 0 false positives on the demo soundtrack. |
| Ears: live audio path | `frontend/src/hooks/useAudioStream.ts`, `/ws/audio` | Mic or soundtrack is resampled in the browser and streamed to the backend in 250 ms frames. The Senses page shows ground-truth markers next to detections. |
| Nose: signal pipeline | `backend/sous/senses/smell.py` | Baseline, humidity compensation, ratio, derivative, hysteresis anomaly detector, signature classifier, escalation. Accepts readings from a board over HTTP or serial. |
| Nose: firmware and bridge | `firmware/`, `tools/serial_bridge.py` | ESP32 + BME688 and Arduino + MQ-135 sketches that post the exact JSON the endpoint accepts. Written against the real Adafruit library API. **Not flashed or run: we had no board.** |
| Order stream → inventory → storefront | `backend/sous/sim/world.py`, `backend/sous/agent/brain.py` | Recipe-level decrement per fired ticket, trailing-window burn rate, minutes-to-stockout, pull items before they 86, promote a substitute, draft a reorder, restore when restocked. |
| Agent and voice | `backend/sous/agent/brain.py`, `llm.py` | Rules decide what to do; the LLM phrases the line and fuses nose context. Hard 6 s timeout and full fallback so the demo never waits on an API. |
| Dashboard | `frontend/` | Kitchen display, customer storefront, back office, senses/hardware page. |

## Simulated: realistic data standing in for a live feed

* **Orders.** A Poisson arrival process over four channels (DoorDash, Uber Eats, phone, walk-in)
  with per-channel item popularity, Dasher ETAs and prep times. In production this is the DoorDash
  merchant order webhook plus the POS.
* **Sensor readings.** `SmellSimulator` produces BME688-like readings (180 kΩ baseline, drift,
  noise, first-order response to a stimulus) and pushes them through the **same `ingest()`** the
  hardware endpoint calls. The UI shows "replaying" whenever this is the source. Time constants
  are compressed for the stage. See `docs/ENOSE.md`.
* **Kitchen soundtrack.** `demo_audio.py` synthesises 75 s of room tone with printer bursts, a
  fryer alarm, a door chime and a pan clatter at known timestamps, so the ears can be judged
  against ground truth regardless of room noise. The mic path works too; the soundtrack exists
  so a loud presentation room cannot sink the demo.

## Mocked: UI only, no logic behind it

* **Storefront menu.** The customer-side menu is our rendering; it is not connected to the
  DoorDash Merchant API. The actions it displays (hide, discount, substitute) are the actions
  the agent actually takes in its own state. Wiring it to the real Menu API is a mapping exercise.
* **Reorder drafts.** Rendered as a card. Nothing is sent to a supplier.
* **Dollar metrics.** "Refunds avoided" counts simulated customers who tried to order an item
  the storefront had already pulled, at $9.80 per incident (our estimate of a missing-item refund
  plus support cost). "Waste saved" is a rough per-unit produce value. Treat both as illustrative.

## How to tell what you are looking at

* Top bar provider badges: `llm: anthropic | nova | rules` and `tts: elevenlabs | browser`.
* Senses page device badge: `none | serial | http | replay`. Anything other than `replay` means
  a physical board is posting.
* Every action in the Back Office log carries `by: rules` or `by: llm`.

## What we would do with one more day

1. Log 24 h from a real BME688 in a refrigerator and set the nose thresholds from data.
2. Replace the hearing rule set with a small learned head on audio embeddings, trained on the
   recordings from that kitchen.
3. Connect the storefront actions to the DoorDash Merchant Menu API (item availability and
   price updates) and read orders from the Order webhook.
