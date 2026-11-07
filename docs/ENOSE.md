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

## Signal pipeline (implemented, `backend/sous/senses/nose/`)

The v2 nose uses the BME688's **heater-sweep**: the sensor steps its heater through four
temperatures (200, 250, 320, 400 °C) and reports one resistance per step. Different gas families
react differently across temperatures, so the four-vector *shape* is a crude chemical fingerprint.
This is the principle behind Bosch's own gas-scan mode; we implement the small-model version.

1. **Calibration** (`calibration.py`). Per-step clean-air baseline from the warm-up window; status
   warming → calibrating → ready; slow adaptation only while the classifier says nominal (so a slow
   rise cannot hide itself); an online least-squares fit of log(R) against relative humidity over
   nominal readings, used to compensate the ~0.8 %/%RH cross-sensitivity; a drift estimate; and a
   0–1 quality score the UI shows. "Place it and it calibrates itself" is this module.
2. **Fingerprint features** (`features.py`). Over the last 30 s of compensated readings: ratio per
   step (baseline ÷ gas; 1.0 is clean air, >1 reducing gas, <1 oxidising gas), the fingerprint
   shape (log-ratios normalised by the 320 °C step), max and mean rise rate, peak magnitude, time
   above threshold, temperature and humidity deltas, and a decay indicator.
3. **Classifier** (`model.py`). Gradient-boosted decision trees over those features. Classes:
   nominal, spoilage (produce: ethanol/acetaldehyde, strongest at high heater temperature),
   spoilage (protein: amines, strongest at low heater temperature), burning (broad, fast, with a
   temperature jump), oil degraded (aldehydes, slow creep at the fry station), cleaning (oxidising
   chlorine: resistance *rises* at some steps, with a humidity jump). Output is a probability per
   class; below a confidence floor the answer is `unknown`, which the agent turns into "take a
   look" rather than an action. Trains in under a minute on CPU; a few hundred kilobytes on disk;
   inference is microseconds, so it runs on the ESP32's host or any Raspberry Pi.
4. **Pipeline** (`pipeline.py`). Accepts 4-step readings or the legacy single `gas_ohm` (then the
   fingerprint is neutral and only kinetics carry information); hysteresis so it does not flap;
   events carry class, confidence, probabilities, fingerprint and an **urgency**: burning → now,
   oil degraded or unknown → next, spoilage → today, cleaning or door-open → info. That urgency is
   what makes the nose's slower, lower-priority signals coexist with the ears' real-time ones.
5. **Honesty about training data.** The classifier is bootstrapped on synthetic windows from the
   physics model in `physics.py` (power-law MOX response, first-order kinetics, per-sensor gain
   ×0.6–1.6, baseline drift, noise, humidity cross-sensitivity, nuisance events such as a door
   left open or someone breathing near the sensor). Its held-out accuracy is therefore an upper
   bound; `tests/eval_nose.py` prints the confusion matrix and detection latency per scenario. The
   first day with hardware replaces the synthetic set with logged data and the same code retrains.

## What the simulator does and does not do

`SmellSimulator` emits readings at 1 Hz with a 180 kΩ clean-air baseline, 1/f-style drift, 0.6 %
Gaussian noise, and first-order rise/decay toward a scenario target. First-order kinetics is a
fair model of a MOX film's response to a step change in concentration; the time constants are
compressed for the stage (spoilage reaches 1.9× in ~30 s, which in a real cooler would take
hours). It calls the same `ingest()` the HTTP endpoint calls, with `source="replay"`, and the UI
shows a banner saying so. When a real board posts, the simulator stops automatically.

What the simulator cannot tell you: whether the fingerprint patterns and thresholds match a real
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
