# ESP32 + BME688 nose

Reads a Bosch BME688 (or BME680) once per second and sends it to the Sous backend
(`POST /api/sensor/reading`) over WiFi, and also prints the same JSON line on Serial.
Physics and caveats are in the header comment of `esp32_bme688.ino`.

> Status: written to the Adafruit BME680 library API but not yet run on hardware.

## Wiring (I2C)

| BME688 breakout | ESP32 dev board |
|---|---|
| VIN / VCC | 3V3 |
| GND | GND |
| SDA (SDI) | GPIO 21 |
| SCL (SCK) | GPIO 22 |
| SDO | leave (0x77) or GND (0x76) |
| CS | leave unconnected (I2C mode) |

The sketch tries address 0x77 then 0x76. Adafruit/Pimoroni boards have onboard pull-ups.

## Libraries (Arduino IDE > Library Manager)

- **Adafruit BME680 Library**
- **Adafruit Unified Sensor**
- ESP32 board package by Espressif (provides `WiFi.h`, `HTTPClient.h`)

The Adafruit BME680 library drives the BME688 in forced mode.

## Board settings

- Board: "ESP32 Dev Module" (or your exact board)
- Upload speed: 921600 (drop to 115200 if uploads fail)
- Serial Monitor: 115200 baud

## Flash

1. Edit the `#define`s at the top of `esp32_bme688.ino`: `WIFI_SSID`, `WIFI_PASSWORD`,
   `SERVER_HOST` (LAN IP of the machine running the backend, not `localhost`), `SENSOR_LOCATION`.
2. Start the backend on `:8000` listening on `0.0.0.0` so the board can reach it.
3. Select board and port, Upload. If upload hangs, hold BOOT while "Connecting..." shows.
4. Open Serial Monitor at 115200. You should see `# WiFi connected` and one JSON line per second.

No WiFi? Skip the credentials, plug into a laptop and run
`python tools/serial_bridge.py --port /dev/ttyUSB0` (lines starting with `#` are ignored).

## Confirm in the dashboard

- `GET http://<server>:8000/api/health` reports `smell_device` as `http` once readings arrive
  (`serial` if via the bridge).
- Senses tab: device status moves `offline` -> `warming` -> `nominal`; the nose trace starts moving.
- Test: hold a cotton swab with a little rubbing alcohol (or a freshly cut onion) near the sensor.
  Gas resistance drops, ratio (baseline / gas) climbs above 1, then recovers.

## Expected values

- Warm-up: let it run ~5 minutes before trusting gas readings; a brand-new sensor benefits from 24-48 h burn-in.
- Clean-air baseline after warm-up: typically **50-500 kOhm** (50,000-500,000 ohm), varying per part, temperature and humidity.
- Temperature reads a little high due to self-heating; mount the sensor away from the ESP32 module.

## Troubleshooting

- `BME68x not found`: check SDA/SCL, try swapping 0x76/0x77, run an I2C scanner.
- `POST failed, code -1`: server unreachable (firewall, wrong IP, backend bound to 127.0.0.1).
- `gas_ohm` falling steadily in the first minutes is warm-up drift, not a leak.
