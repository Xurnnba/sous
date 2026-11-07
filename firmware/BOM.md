# Sous nose: bill of materials

## Option A (recommended): ESP32 + BME688, about US$25-35

| Part | Notes | Approx. US$ |
|---|---|---|
| ESP32 dev board (ESP32-DevKitC or similar) | WiFi, 3.3 V logic | 8-12 |
| BME688 breakout (Adafruit 5046 or Pimoroni PIM-series) | I2C, 0x76/0x77, includes pull-ups | 18-23 |
| Jumper wires (4) + micro-USB/USB-C cable | | ~2 |

Firmware: `esp32_bme688/`. BME680 breakouts also work (cheaper, same API, no AI features).

## Option B: Arduino Nano + MQ-135, about US$12

| Part | Notes | Approx. US$ |
|---|---|---|
| Arduino Nano (or clone) | 5 V, 10-bit ADC | 5-8 |
| MQ-135 module | analog out, on-board 10 kOhm load resistor (verify) | 3-5 |
| Jumper wires + USB cable | | ~2 |

Firmware: `arduino_mq135/`. No WiFi, so use `tools/serial_bridge.py`. The heater needs a real 5 V supply
and draws roughly 150 mA.

## What each sensor can and cannot tell you

| | BME688 | MQ-135 |
|---|---|---|
| Measures | One MOX resistance per heater step (we use one: 320 C, 150 ms), plus temp, RH, pressure | One MOX resistance (via analog divider) |
| Direction | Lower ohms = more reducing VOCs | Same |
| Identifies a specific gas? | **No.** | **No.** Datasheet curves for NH3/CO2/benzene are for lab conditions; ppm numbers from hobby modules are not trustworthy. |
| Good for | Relative change from a clean-air baseline: "something got worse here" | Same, coarser and noisier |
| Humidity | Reports RH so it can be compensated | No RH/temp; ambient changes look like gas changes |

Classifying a rise as spoilage vs burning vs oil degradation vs cleaning chemicals needs **context** (which
location, how fast it rose, RH, what the kitchen is doing) and/or a **trained model**: Bosch BSEC and
BME AI-Studio use multiple heater temperatures to build a gas "fingerprint". Sous currently uses context
plus rate-of-rise rules on a single channel; it does not claim gas identification.

## Operational notes

- **Warm-up:** ~5 minutes after each power-up before readings settle; 24-48 h burn-in for new sensors (MQ-135 especially).
- **Humidity cross-sensitivity:** MOX resistance moves with RH. A walk-in door opening (warm, humid air) can shift
  readings without any VOC change. Re-baseline per location and watch rh alongside gas.
- **Drift and aging:** baselines wander over days/weeks; the backend baseline should adapt slowly.
- **Placement:** away from the cooker hood, door draught and the ESP32 itself (self-heating); avoid silicone sprays and sanitizer
  fumes near the sensor, which can poison or swamp it.
- **Safety:** this is a freshness/anomaly indicator, not a certified smoke, CO or gas-leak detector.
