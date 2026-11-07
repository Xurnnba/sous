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

## The 3-minute demo

Open the **Live** tab on the projector; keep **Storefront** on a second screen or phone. The
**Run demo** button in the top bar plays the whole sequence below on its own (rush, soundtrack,
tab switches, nose scenarios) over about 2.5 minutes, so you can narrate instead of clicking.

1. **Sad path first (30 s).** Say: "Friday, 7 pm, every restaurant in Pittsburgh. Someone orders
   guacamole. The avocados ran out ten minutes ago. Nobody updated the app. The customer waits,
   the order gets cancelled, the restaurant eats the refund." Click **Rush**.
2. **The ears (45 s).** Click **Play soundtrack**. The ticket printer bursts turn into walk-in
   orders on the board that no tablet knew about. The fryer alarm fires with nothing on the fryer
   ticket and Sous asks someone to check station 2. The door chime arrives before the Dasher's
   order is ready and Sous tells the line to let the Dasher know. Point at the Senses tab's
   truth-vs-detected timeline if asked.
3. **The storefront moment (30 s).** Within about half a minute of rush the voice says
   "Avocado runs out in about 9 minutes. Pulling Avocado Toast and Guacamole from DoorDash and
   Uber Eats now, promoting Tomato Toast at 15 percent off. Reorder draft for 22 is ready."
   Switch to **Storefront**: the items are greyed out with the reason, the substitute has a promo
   badge. "Refunds avoided" starts counting the customers who tried to order them.
4. **The nose (45 s).** On **Senses**, click **Spoilage in walk-in**. Watch the ratio climb on the
   Back Office chart; after a few seconds Sous says the avocado is turning, discounts every avocado
   dish to move it today, and drafts "skip tomorrow's order". Then click **Burning at station**:
   the signature escalates and the voice alerts immediately. Click **Cleaning cycle**: a sharp spike
   that it correctly ignores. Say out loud: "No board today, so this trace is synthetic, replayed
   through the same endpoint the ESP32 posts to. The firmware is in the repo."
5. **Human in the loop (15 s).** On Storefront press **We got more** under Avocado Toast. Stock
   resets, the menu restores, the voice confirms. The agent acts, but a human can always override.

If the room is loud and the mic path misbehaves, the **inject** buttons on Senses trigger each
hearing event directly. The soundtrack path does not depend on the room at all.

## Repository map

```
backend/sous/sim/        menu, recipes, order stream, inventory, storefront state
backend/sous/senses/     hearing.py (DSP classifier), smell.py (nose pipeline + simulator), demo_audio.py
backend/sous/agent/      brain.py (decisions + voice), llm.py (provider shim), tts.py
backend/sous/api.py      FastAPI + websockets, serves frontend/dist
frontend/                Vite + React + Tailwind dashboard (Kitchen, Storefront, Back Office, Senses)
firmware/                ESP32+BME688 and Arduino+MQ-135 sketches, BOM
tools/serial_bridge.py   forward a serial-connected sensor to the backend
docs/ENOSE.md            e-nose design, physics, pipeline, limitations, validation plan
docs/JUDGES.md           what is real, simulated and mocked
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
