# For judges: what is real, what is simulated, what is mocked

We would rather you know exactly where the seams are than discover one yourself. Everything in
the first table can be verified live and unscripted: play any sound from the phone Sound Board in
any order, teach the system a new sound, switch nose scenarios, dismiss items.

## Real: code that runs and does the work

| Component | Where | What it does | How to check it live |
|---|---|---|---|
| Ears: embedding model | `backend/sous/senses/ear/embedder.py` | YAMNet (3.7 M params) on CPU, 7 ms per second of audio | Ears page shows the top-3 AudioSet classes updating as you make noise |
| Ears: classifier | `backend/sous/senses/ear/classifier.py` | Noise floor, AGC, spectral gate, zero-shot prior, few-shot k-NN with room background, merge/hold/burst | Play a clip from your phone across the room; the event appears with how/confidence/heard-as |
| Ears: calibration | same, `PrototypeStore` | Teach a sound in 4 s through the real mic; noise-augmented prototypes persisted to JSON | Press Teach, play the clip, watch "Learned N examples"; play it again, it is now "taught" not "zero-shot" |
| Ears: multi-mic | `backend/sous/senses/ear/streams.py` | Any device joining `/ws/audio` is a mic with a location | Open the Ears page on a phone, press Listen as "front": two mics appear |
| Nose: calibration | `backend/sous/senses/nose/calibration.py` | Per-step baseline, drift adaptation, online humidity-slope fit, quality score | Nose page calibration card |
| Nose: classifier | `backend/sous/senses/nose/model.py`, `features.py` | Gradient-boosted trees on heater-sweep fingerprint features; `unknown` when unsure | Probability bars move with the fingerprint; `tests/eval_nose.py` prints accuracy and confusion |
| Nose: firmware | `firmware/` | ESP32 + BME688 and Arduino + MQ-135 sketches posting the exact JSON the endpoint accepts | Code review; **not flashed, we had no board** |
| Orders → storefront | `backend/sous/sim/world.py`, `agent/brain.py` | Recipe-level inventory, burn rate, stockout prediction, pull/promote/reorder, restore | Turn Rush on; within about a minute avocado dishes are pulled on the Storefront page |
| Agent | `backend/sous/agent/items.py`, `brain.py` | Every signal → one prioritised item; dedupe with counts; auto-expire; auto-resolve; voice for "now" items | Board page; dismiss an item; watch a Dasher item close itself on handoff |
| Voice | `backend/sous/agent/tts.py` | ElevenLabs clips for fixed lines, live synthesis with a key, browser fallback | Unmute |

## Simulated: realistic data standing in for a live feed

* **Sensor readings.** No gas-sensor board was available on the day. The nose simulator produces
  BME688-like 4-step heater-sweep readings from a physical response model (power-law MOX
  response, first-order kinetics, gain variation, drift, noise, humidity cross-sensitivity) and
  pushes them through the same `ingest()` the hardware endpoint calls. The UI says "replay"
  whenever this is the source. The classifier was trained on synthetic windows from the same
  model, so its accuracy number is an upper bound until it sees a real sensor. Time constants are
  compressed for the stage.
* **Orders.** Poisson arrivals over DoorDash, Uber Eats, phone and walk-in with per-channel item
  popularity and Dasher ETAs. In production: the DoorDash order webhook plus the POS.
* **Sound-effect clips.** The Sound Board clips are generated (ElevenLabs text-to-sound), not
  recordings from a kitchen. The ears are evaluated on them with synthetic room degradation; a
  real kitchen needs an hour of recording and a re-run of the sweep.

## Mocked: UI only

* **Storefront menu.** Our rendering of a delivery-app menu; the hide/discount/substitute actions
  are real in our state but not sent to the DoorDash Merchant API.
* **Reorder drafts.** Rendered; nothing is sent to a supplier.
* **Dollar metrics.** Illustrative estimates ($9.80 per avoided missing-item refund, rough produce value).

## How to tell what you are looking at

* Ears page: each event says `taught`, `zero-shot` or `injected`.
* Nose page: device badge `replay` vs `http`/`serial`; model badge shows features and accuracy.
* Board: every item carries its sense, its location and the evidence behind it.
* Providers in the More menu: `llm rules|anthropic|nova`, `tts cache|elevenlabs|browser`, `ears ready`.
