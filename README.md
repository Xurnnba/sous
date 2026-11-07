# SOUS — the kitchen's other senses

Cameras are the obvious kitchen sensor. We built everything but.

Sous is a multisensory AI expeditor for a restaurant kitchen. It **hears** the kitchen through a
microphone (ticket printer, fryer alarm, door chime, clatter), **smells** it through a VOC gas
sensor (produce turning, something burning, fry oil degraded), and **reads the order stream** at
recipe level to predict stockouts before they happen. It fuses the three and does two things:
speaks one terse line to the line cooks, and **acts on the storefront**, pulling a dish from
DoorDash and Uber Eats before a customer orders something the kitchen cannot make, promoting a
substitute, and drafting the reorder.

Built for the DoorDash track at NOVA (CMU, 7 Nov 2026). Front of house: order timing, packing
and pickup (ears + fire calls + Dasher handoff). Back of house: inventory, forecasting, waste
(nose + stockout prediction + reorder drafts). One system, several pain points.

## Fastest way to demo (no install)

A hosted instance runs on the team VM: **https://novah.exe.xyz:8000/** (Board). Open it on the laptop,
press **Listen**, and open the Sound Board link shown on the Ears page on a phone. The link is
private to the exe.dev account by default; to let a judge's phone open it without logging in, run
once from your own machine:

```bash
ssh exe.dev share set-public novah
```

Mic audio goes browser → VM over the websocket; nothing is recorded. The voice clips, the ear model
and the nose classifier all run on the VM, so the laptop needs only a browser.

## Run it

Quickest: one command builds the frontend if needed and serves everything on http://localhost:8000.

```bash
./start.sh
```

Step by step:

```bash
# backend (Python 3.12)
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt
```

```bash
cd frontend && npm install && npm run build && cd ..
```

```bash
backend/run.sh
```

Open http://localhost:8000. For frontend hot reload instead, run `npm run dev` in `frontend/`
and open http://localhost:5173 (it proxies to the backend).

Optional environment:

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Agent phrases its lines and fuses nose context with Claude (`SOUS_MODEL`, default `claude-sonnet-5-5`) |
| `NOVA_TEAM_ID`, `NOVA_SERVER_URL` | Same, through the hackathon's Nova model proxy (`pip install nova-client-sdk`) |
| `ELEVENLABS_API_KEY` | Every spoken line rendered by ElevenLabs at runtime (voice "Deon M", override with `ELEVENLABS_VOICE_ID`) |
| `SOUS_NOSE_AUTOSTART=0` | Don't start the sensor simulator; wait for a real board |

Without any of them it runs fully in rules mode. Nothing in the demo depends on an external API.

**Voice.** The demo's signature lines (stockout call, nose findings, fryer alarm, Dasher at the door,
and so on) ship pre-rendered with ElevenLabs in `backend/voice_cache/`, so they sound the same with
or without a key. Only the dynamic fire calls ("Fire D-104, Crispy Fries") fall back to the browser
voice when no key is set. `tools/render_voice_cache.py` re-renders the fixed lines if you change them.

## The demo (unscripted, verifiable)

Open the **Board** on the projector. Hand a judge your phone open at `/#/sounds`. Nothing below is
pre-recorded or pre-ordered; the judge picks.

1. **Ears, zero-shot.** The laptop mic is listening (Listen is on, location "kitchen"). The judge taps
   any sound on the phone from across the room. Within a second the Ears event stream shows what the
   model heard (`zero-shot · 0.9 · Alarm`), the Board grows an item with an urgency, and the voice
   speaks only if it is a *now* item. Tap the same sound again: one item, count ×2, no second line.
2. **Ears, calibrated in four seconds.** On the Ears page press **Teach → Ticket printer**, have the
   judge play the printer clip during the countdown. "Learned 14 examples." Play it again: the event
   now says `taught · 0.93`. Forget it; it goes back to zero-shot. This is the whole calibration
   story and it happens in front of them.
3. **Nose.** On the Nose page the fingerprint bars sit at 1.0 and the calibration card says ready.
   The judge picks any scenario. Spoilage (produce) ramps three of four bars, the probability bar for
   produce climbs past the threshold, a *today* item appears with the auto-action (discount + skip
   reorder) and the storefront changes. Burning spikes all four bars with a temperature jump → *now*.
   Cleaning pushes one bar *below* 1.0 (oxidising gas) → an informational item that expires on its own.
   Say out loud: no board today, this is replayed sensor physics through the hardware endpoint, the
   classifier is real and `tests/eval_nose.py` prints its confusion matrix.
4. **Agent.** Turn on Rush. Within about a minute: "Avocado is about to run out", three dishes pulled
   from the Storefront, a *next* item asking the owner to approve the drafted reorder. Press **We got
   more** on the Storefront; the item closes itself.
5. **Trust.** Every item shows its evidence. Every event says how it was decided. Dismiss anything.

Before judging, start from a clean calibration so nothing learned during testing leaks in:

```bash
curl -X DELETE http://localhost:8000/api/ear/prototypes/_all
```

Fallbacks if the room is hostile: a second phone as a "front" mic placed near the speaker; the
inject buttons on the Ears page; the soundtrack button, which streams the same clips straight into
the classifier with a truth-vs-detected timeline.

## Repository map

```
backend/sous/sim/        menu, recipes, order stream, inventory, storefront state
backend/sous/senses/ear/ embedder.py (YAMNet), classifier.py (AGC, gate, zero/few-shot, merge), streams.py (multi-mic), sounds.py
backend/sous/senses/nose/ physics.py (sensor model + simulator), calibration.py, features.py, model.py (GBDT), pipeline.py
backend/sous/agent/      items.py (action-item store), brain.py (signals → items + storefront actions + voice), llm.py, tts.py
backend/sous/api.py      FastAPI + websockets, serves frontend/dist
frontend/                Vite + React + Tailwind (Board, Ears, Nose, Kitchen, Storefront, Sounds)
firmware/                ESP32+BME688 and Arduino+MQ-135 sketches, BOM
tools/serial_bridge.py   forward a serial-connected sensor to the backend
docs/ARCHITECTURE.md     how the pieces fit
docs/EARS.md             ear design and measured recall / false positives
docs/ENOSE.md            e-nose design, physics, fingerprint classifier, limitations, validation plan
docs/JUDGES.md           what is real, simulated and mocked, and how to check each live
backend/tests/           eval_ear.py, sweep_ear.py, eval_nose.py (reproducible numbers)
CONTRACT.md              backend/frontend message contract
```

## Deck outline (6 slides)

1. **The problem**: missing items and 86'd dishes still sold online are the top merchant refund
   driver; restaurants run at 3–5 % margin. Persona: line cook at 7 pm, owner at 11 pm with a shoebox of invoices.
2. **The idea**: cameras are the obvious sensor; we built the other two senses, plus an agent that
   acts on the storefront instead of sending a notification.
3. **Demo** (live).
4. **How it works**: one diagram, three inputs, rules decide, LLM phrases and fuses context, voice + storefront actions.
5. **Trade-offs and failure modes**: single-channel nose cannot name a gas, so it asks a human when
   unsure; hearing rules tuned on synthesized sounds, learned model next; every action reversible by staff.
6. **With DoorDash data**: order webhook in, Menu API out, missing-item rate as the metric; sensor BOM under $35 per station.
