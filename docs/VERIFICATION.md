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

## Verified through the public exe.dev proxy (outside-in, no login)

Fetched from the proxy's public address (161.210.92.223, resolved via 1.1.1.1) with no exe.dev
session cookie, after the owner ran `share set-public`:

| URL | Result |
|---|---|
| `https://novah.exe.xyz:8000/api/health` | 200, application/json, ears ready, nose gbdt-fingerprint |
| `https://novah.exe.xyz/api/health` | 200, same body |
| `https://novah.exe.xyz:8000/api/sounds/door_chime.wav` | 200, audio/wav, 32,044 bytes (the Sound Board clip) |
| Live state while the owner's browser had Listen on | one real microphone connected over the proxy websocket: location "front", source mic, model yamnet, 18 windows processed, top class Speech, noise floor -56 dBFS |

The connected mic is the end-to-end proof for the hosted path: browser microphone → `/ws/audio` through
the TLS proxy → YAMNet on the VM → state back over `/ws`.

## Verified in the real room by the owner's own microphone (20:30, 7 Nov)

While the owner rehearsed, their real device (mic `ssvyzc`, location "front") produced these items on
the hosted Board, all zero-shot with no prior teaching, all at phone-across-a-room levels:

| Item | Heard as | Level | Outcome |
|---|---|---|---|
| Fries up: plate them for U-10 (fryer alarm matched to a cooking fries order) | Beep, bleep | -32 dBFS | marked Done by the owner |
| Phone ringing: pick up | Ringtone | -38 dBFS | expired on its own |
| Something dropped at the front: check for breakage | Glass | -37 dBFS | open |

This is the phone → room → laptop microphone → proxy → model → Board path working in the actual venue.

## Not verifiable from the build VM, and why

* **Speaker playback of the voice lines** was not observed from the VM (no audio device here); the
  clips are served correctly over the proxy and the owner's microphone picked up the phone's playback
  of the sound clips in the room (above).
* **A real gas sensor.** None was available; the classifier is trained and evaluated on the physics
  model, so its accuracy is an upper bound until it sees logged sensor data.
