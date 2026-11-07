# Scent room (nose demo)

A judge scans a QR code, gets a 2D floor plan of the kitchen with virtual noses in it, and drags
scent sources (spoiled produce, spoiling protein, a burnt pan, old fry oil, cleaner spray, fresh
food) onto the plan. Each nose runs the real nose pipeline (calibration → fingerprint → GBDT
classifier → anomaly logic) on simulated BME688 heater-sweep readings built from the gas
concentration *at that nose's position*. Detections flow through the normal agent, so the Board,
inventory, storefront and voice react exactly as they would to hardware.

Honesty: the air is simulated; the noses never see what was dropped, only the chemistry at
their position. Which ingredient is affected is *inferred* from sensor readings plus where each
ingredient is shelved (known inventory data).

## Backend — `backend/sous/senses/nose/room.py` (`ScentRoom`)

Coordinates: room is `W=100` × `H=60` units, origin top-left.

Layout (static, returned by `GET /api/room`):

```
zones: [{id, label, x, y, w, h, kind}]   kind: "cold" | "dry" | "hot" | "prep" | "front"
  walk-in   (cold)  x 0..30,  y 0..32     closed room; door on its right wall at y 22..30
  dry       (dry)   x 0..30,  y 32..60    dry storage
  prep      (prep)  x 30..62, y 0..30
  line      (hot)   x 62..100, y 0..30
  fry       (hot)   x 62..100, y 30..60   fry station
  pass      (front) x 30..62, y 30..60    pass / pickup
doors: [{zone:"walk-in", x:30, y1:22, y2:30}]
bins:  [{id, ingredient, label, x, y, zone, category}]   category: "produce" | "protein" | "dairy" | "dry" | "line"
  walk-in: avocado (produce), tomato (produce), chicken (protein), carnitas (protein), eggs (protein), cheese (dairy)
  dry: tortilla, sourdough, potatoes (dry)   line: salsa_verde, horchata (line)
  (ingredient names are the World inventory keys)
noses: [{id, label, x, y, zone, location}]  location ∈ physics LOCATION_TEMP_C keys
  walkin-produce  "Walk-in · produce shelf"  near the produce bins      location "walk-in"
  walkin-protein  "Walk-in · protein shelf"  near the protein bins      location "walk-in"
  line            "Line"                                                location "line"
  fry             "Fry station"                                         location "fry-station"
palette: [{kind, label, gas, good, sustained, desc}]
  spoiled_produce  "Spoiled produce"  gas spoilage_produce  good=false sustained
  spoiling_protein "Spoiling protein" gas spoilage_protein  good=false sustained
  burnt_pan        "Burnt pan"        gas burning           good=false sustained
  old_fry_oil      "Old fry oil"      gas oil_degraded      good=false sustained
  cleaner_spray    "Cleaner spray"    gas cleaning          good=true  transient (~12 s hold, then decays; source auto-removed when spent)
  fresh_produce    "Fresh produce"    gas null              good=true  (dropped near a produce bin it swaps the tray: removes bad sources within 8 units of that bin; the source itself emits nothing and fades after ~6 s)
  fresh_protein    "Fresh protein"    gas null              good=true  (same, for protein bins)
```

Dynamic state, `ScentRoom.snapshot()`; included in the websocket snapshot as `state.room` and in
`GET /api/room` as `state`:

```
{
  sources: [{id, kind, label, x, y, age_s, emission (0..1 current), bin: ingredient|null}],
  noses: [{id, label, x, y, location, status: "calibrating"|"nominal"|"anomaly",
           deviation, ratios:[4], prediction:{label, confidence}|null,
           anomaly:{kind, label, confidence, urgency}|null, air: {gas: conc} (simulated truth, for the UI's "simulated air" readout)}],
  inferences: [{t, nose_id, kind, label, est_x, est_y, ingredient|null, summary}],   newest first, max 12
  inventory: [{name, label, freshness, on_hand, unit, location}]                      walk-in items only
}
```

Physics: each source emits its gas with first-order rise (tau 4–8 s) while placed, decays (tau
~8 s) after removal or when transient. Concentration at a nose:
`Σ emission · strength · exp(-d² / (2σ²)) · attenuation`, σ ≈ 14, strength chosen so a source
right next to a nose gives conc ≈ 1.2 (the mid range of the trained scenarios) and a source in
the next zone gives clearly less. Attenuation 1.0 within a zone, 0.5 between open zones, 0.04
through the walk-in wall (0.35 if the straight path passes through the door gap). Readings built
like `physics.Simulator.reading` (per-sensor `SensorPhysics`, drift, noise, location temp/RH),
pushed through one `NosePipeline` per nose (share one loaded `NoseModel`), stepped at 1 Hz from
the hub loop.

Events: each pipeline's events are wrapped: add `data.nose_id`, `data.source = "room"`, and for
anomalies a location estimate (`data.est_xy`, weighted centroid of nose positions by deviation,
noses below the anomaly threshold excluded) and `data.ingredient` (nearest bin whose category
fits the class: produce for spoilage_produce, protein for spoilage_protein; none for others).
`voc_clear` gets `data.ingredient` of the anomaly it clears. Wrapped events go to the hub's normal
smell-event path (`Hub._smell_event`) so the brain handles them.

Brain (`agent/brain.py`): prefer `data.ingredient` over `most_perishable_in("walk-in")` for produce
and protein; on `voc_clear` with an ingredient that is turning/watch, set it back to fresh, clear
its push discounts, emit an action and log it.

REST:
```
GET    /api/room                      -> {layout, palette, state}
POST   /api/room/source  {kind,x,y}   -> source      (400 bad kind; max 12 sources)
POST   /api/room/source/{id}/move {x,y} -> source
DELETE /api/room/source/{id}          -> {ok}
POST   /api/room/reset                -> {ok}       (removes sources; noses keep calibration)
```

## Frontend — `#/room`

`src/views/ScentRoom.tsx`, nav entry "Scent room". Works on a phone (the judge) and on the
projector (inside the normal shell). SVG floor plan (viewBox 0 0 100 60), palette of scent chips,
drag with pointer events (touch-action: none) from palette onto the plan, drag placed sources to
move them, tap × to remove. Noses show live status; a soft haze shows the simulated plume. A side
/ bottom panel lists each nose's reading and classification, the inference feed ("Walk-in protein
shelf: spoiling protein → nearest protein bin: chicken → chicken flagged"), and walk-in inventory
freshness. A QR panel on the Nose page links phones to `#/room` (same LAN-address logic as the
sound board on the Ears page).

## Verification notes (end-to-end pass)

- Ingredient attribution only blames a bin in the same zone as the estimated plume; a spoilage smell
  placed away from any matching shelf yields a "smell near the <zone>: take a look" Board item, no ingredient.
- Placement prior: walk-in (cold) noses cannot report `burning` / `oil_degraded`. The classifier is
  trained on single gases, and produce + protein mixed in the walk-in otherwise lands on "burning". Such a
  call is renormalised over the allowed classes (or folded into the nose's open anomaly, or `unknown`).
  With both smells present the walk-in noses report the first plume (protein is not separately flagged).
- `POST /api/room/reset` (the "Clear room" button) and a server restart close room-sourced Board items
  and return room-flagged stock to fresh.
- `tests/eval_room.py` includes two mixture cases (14 cases).
