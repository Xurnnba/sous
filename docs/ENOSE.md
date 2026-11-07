# The nose: electronic-nose design notes

This document is for judges and for whoever picks up the hardware next. It explains what the
e-nose feature does, how it is implemented end to end, which parts ran in the demo, and
exactly what is missing because we did not have a sensor board on the day.

## What we claim, in one paragraph

A single cheap metal-oxide (MOX) VOC sensor in a walk-in cooler or over a fry station produces
a one-dimensional time series. That series cannot name a gas. But the **shape** of the response
(how fast it rises, how high, whether it clears, whether temperature moved with it) combined with
**context** (where the sensor is, what is stored there, the time of day, what the kitchen sounds
like) is enough to separate four operationally useful states: produce or protein turning,
something burning, fry oil degraded, and a cleaning-product spike that should be ignored. The
pipeline that does this is implemented and running; the only component we could not demonstrate
live is the board itself, so the demo replays synthetic sensor traces through the same HTTP
endpoint the board posts to.

## Why smell, and why these four states

| State | Chemistry a MOX sensor responds to | What the kitchen does with it | Who pays today |
|---|---|---|---|
| Spoilage (walk-in) | Ethanol/acetaldehyde from fermenting produce; ammonia and amines from protein | Promote dishes using the stock today, skip tomorrow's order | Waste is typically 4–10 % of food cost |
| Burning (line) | Acrolein, aldehydes, CO, smoke particulates | Immediate voice alert, a human checks the station | Remakes, late orders, fire risk |
| Oil degraded (fry station) | Acrolein and other volatile oxidation products rising slowly over a shift | "Change the oil now" instead of on a calendar | Oil is bought too early or used too long |
| Cleaning spike | Chlorine / quaternary ammonium compounds | Suppress alerts for two minutes | Nothing; avoiding a false alarm |

## Sensor physics in five sentences

A MOX sensor is a heated tin-oxide film. In clean air oxygen adsorbs on the surface and traps
electrons, so the film's resistance is high. Reducing gases (ethanol, amines, aldehydes) react
with that adsorbed oxygen and release the electrons, so resistance **falls**. The response is
roughly a power law in concentration and depends on heater temperature, humidity and the
sensor's age, so absolute ohms are not comparable between sensors or days. We therefore work
with the dimensionless ratio **baseline ÷ current resistance** and its time derivative; 1.0 is
clean air, 2.0 means the film is twice as conductive as in clean air.

## Hardware (designed, not demonstrated)

Two options are specified in `firmware/BOM.md`:

* **Option A, recommended:** ESP32 dev board + Bosch BME688 breakout, about US$25–35. One I2C
  sensor gives gas resistance, temperature, humidity and pressure, which is exactly the set the
  compensation step needs. Firmware: `firmware/esp32_bme688/esp32_bme688.ino`.
* **Option B, cheapest:** Arduino Nano + MQ-135, about US$12. Analog only; no humidity channel,
  so compensation is skipped. Firmware: `firmware/arduino_mq135/arduino_mq135.ino`.

Both post the same JSON once per second:

```json
{"sensor_id":"esp32-01","location":"walk-in","gas_ohm":182340.0,"temp_c":3.6,"rh":61.2,"pressure_hpa":981.4,"t":1234.5}
```

to `POST /api/sensor/reading`. A board without WiFi prints the same line to serial and
`tools/serial_bridge.py` forwards it from a laptop. The backend does not know or care which
of the three sources is talking; the `device` badge in the UI only reports it.

## Signal pipeline (implemented, in `backend/sous/senses/smell.py`)

1. **Warm-up and baseline.** The first N readings establish a median baseline. On real hardware
   the heater needs ~5 minutes to stabilise, so N should be ~300; the demo uses 12 so the sensor
   is "online" in seconds. Baseline humidity is recorded at the same time.
2. **Humidity compensation.** MOX resistance drops as relative humidity rises. We apply a
   first-order correction of 0.8 % resistance per %RH relative to the baseline humidity. This is
   the same order of magnitude Bosch uses in BSEC; a production version would fit the slope
   per sensor during burn-in.
3. **Ratio and derivative.** `ratio = baseline / compensated_gas`. The derivative is computed
   over a 5 s window. Both feed the detector and are shown live in the Back Office chart.
4. **Slow baseline adaptation.** While the state is nominal and the ratio is below 1.1 the
   baseline tracks the signal with a very long time constant, so drift over a shift does not
   become a false alarm. Adaptation is frozen during an anomaly so a slow rise cannot hide itself.
5. **Anomaly detection.** Ratio above 1.35 sustained for 4 s raises an anomaly; below 1.15 for
   8 s clears it. Hysteresis stops chatter around the threshold.
6. **Signature classification.** A rule set over peak rise rate, magnitude, temperature delta
   and location labels the anomaly, with an explicit prior confidence:
   * fast (>0.25/s) and large (>2.5×) or with a temperature jump → burning (0.8)
   * fry-station and slow (<0.03/s) → oil degraded (0.65)
   * sharp spike (>0.12/s) in a cold room → cleaning product (0.55)
   * walk-in and slow → spoilage (0.7)
   * anything else → unknown (0.3), which the agent turns into "ask a human"
7. **Escalation and relocation.** A slow anomaly that suddenly turns fast and large is re-emitted
   as burning. Readings from a new location reset the anomaly bookkeeping but keep calibration.
8. **Context fusion (LLM).** The anomaly, its features, the sensor location, the most perishable
   stock in that location and its age, the time since open, the recent kitchen sounds and the
   current order load are handed to the model, which returns `{kind, confidence, action, line}`.
   The action set is deliberately small: promote, alert, change_oil, ignore, ask_human. If the
   model is unavailable or slow (6 s timeout) the rule label and a templated line are used, so
   the demo never stalls.
9. **Action.** Spoilage → mark the ingredient "turning", discount every dish using it, draft a
   zero-quantity reorder for tomorrow. Burning → alert. Oil → change-oil task plus a reorder draft.
   Cleaning → suppress. Unknown → ask a human. The voice says one line.

## What the simulator does and does not do

`SmellSimulator` emits readings at 1 Hz with a 180 kΩ clean-air baseline, 1/f-style drift, 0.6 %
Gaussian noise, and first-order rise/decay toward a scenario target. First-order kinetics is a
fair model of a MOX film's response to a step change in concentration; the time constants are
compressed for the stage (spoilage reaches 1.9× in ~30 s, which in a real cooler would take
hours). It calls the same `ingest()` the HTTP endpoint calls, with `source="replay"`, and the UI
shows a banner saying so. When a real board posts, the simulator stops automatically.

What the simulator cannot tell you: whether the heuristic thresholds are right for a real
cooler. That requires a day of logging with a board, which is the first thing to do with the
hardware.

## Honest limitations

* **Single channel.** One MOX channel is not a chemical identifier. The BME688 can step its
  heater through up to ten temperatures and produce a crude "fingerprint"; Bosch's AI Studio
  can train a classifier on those. We did not do that. Our labels come from response shape and
  context, and the confidence numbers are priors, not calibrated probabilities.
* **Cross-sensitivity.** Humidity, temperature, a door opening, a person breathing near the
  sensor, and alcohol-based sanitiser all move the signal. Compensation covers humidity;
  context and the hysteresis cover some of the rest; the model is told to prefer `ask_human`
  when unsure.
* **Placement matters.** A sensor by the walk-in door sees every open-close. It belongs on the
  back wall at produce height.
* **Warm-up and drift.** Minutes of warm-up after power-on; weeks of slow drift over the sensor's
  life. The adaptive baseline covers drift; the UI shows a "warming" status after power-on.

## Validation plan with hardware (first day)

1. Mount a BME688 in a home refrigerator and a fry pan setup; log 24 h of clean readings to fix
   the warm-up length, baseline range and drift rate.
2. Stimuli at known times: a cut onion, a splash of vinegar, rubbing alcohol on a cloth,
   a browning piece of bread, a drop of bleach. Record rise rate and magnitude for each; set
   the thresholds from data instead of from the demo.
3. Leave a tray of avocados and a tray of chicken for three days; log the slow rise. This is the
   trace that proves the spoilage story.
4. Replay those recordings through `/api/sensor/reading` in the demo, so the stage trace is real
   data even when the board is not in the room.
