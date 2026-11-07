# Verification record (final, 7 Nov 2026 evening)

What was verified, how, and what could not be verified from the build machine.

## Verified on the running server (`tests/e2e_backend.py`, `tests/eval_ear.py`, `tests/eval_nose.py`, Playwright)

| Check | Result |
|---|---|
| Ears, zero-shot, soundtrack streamed as a microphone over `/ws/audio` | all 5 kinds detected (printer, fryer alarm, door chime, phone, plates), 0 false alarms |
| Ears, zero-shot offline eval, clean / 4 m room | 10/10 · 0 fp / 8/10 · 1 fp |
| Ears, teach printer for 6 s through the mic, replay | recognised `taught · 0.93` |
| Ears, prototypes and room noise persist across reconnects and restarts | yes (`data/ear_prototypes.json`, `data/ear_rooms.json`) |
| Nose, held-out accuracy (synthetic physics windows) | 0.954 overall, 0.997 on 4-step fingerprints |
| Nose, scenario sequence spoilage → burning → cleaning → nominal → oil → door → protein | one correct event each, 3–9 s latency, nothing on nominal / door / tails, 10/10 seeds |
| Agent, items from every sense with dedupe, urgency, auto-actions, auto-resolve, Done/Dismiss via UI | yes |
| Storefront pull / promote / reorder on predicted stockout, restore on "We got more" | yes |
| Voice, every fixed line served as a cached ElevenLabs clip | 20/20 lines hit the cache |
| Frontend, all six views at 1440×900 and Sounds at 390×844, 7 open items with scrolling columns, voice panel on screen, zero console errors | yes (screenshots in `docs/screenshots/`) |
| Nose page during a sensor relocation shows a coherent "Calibrating at <location> · n/6" state | yes |
| Backend log after the full run | 0 tracebacks |

## Verified earlier from the user's network

Requests from a CMU address (128.237.x.x) reached the hosted instance through the exe.dev proxy
during the first demo session (REST and the live websocket-fed Board), so the proxy path works for a
logged-in exe.dev user.

## Not verifiable from the build VM, and why

* **Public proxy access.** Making the link public needs `ssh exe.dev share set-public novah` from a
  machine with the account's SSH key; the VM has none, and the VM cannot reach its own public
  address (no egress route), so an end-to-end HTTPS check from inside is impossible.
* **Real microphone and speaker.** The VM has no audio devices. The mic path was exercised with
  streamed PCM over the same websocket the browser uses, and the headless browser's fake microphone;
  a real room still needs one rehearsal.
* **A real gas sensor.** None was available; the classifier is trained and evaluated on the physics
  model, so its accuracy is an upper bound until it sees logged sensor data.
