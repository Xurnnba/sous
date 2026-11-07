#!/usr/bin/env python3
"""Serial -> HTTP bridge for the Sous electronic nose.

Why this exists: the sensor (ESP32+BME688 or Arduino+MQ-135) prints one JSON
line per second over USB serial. This script forwards those lines to the Sous
backend's hardware endpoint (POST /api/sensor/reading), so the sensor can run
straight from a laptop with no WiFi credentials flashed into the firmware.
It is also the only path for the Arduino/MQ-135 option, which has no WiFi.

Behaviour:
  * Lines that are not valid JSON, or start with '#' (firmware comments), are
    skipped without crashing.
  * Required keys: sensor_id, location, gas_ohm. temp_c / rh / pressure_hpa / t
    are optional (null is fine). gas_ohm must be a positive number.
  * Serial disconnects (unplug, board reset) and HTTP failures are tolerated;
    the bridge keeps retrying.

Usage:
  pip install pyserial requests
  python tools/serial_bridge.py --port /dev/ttyUSB0 --server http://localhost:8000
  python tools/serial_bridge.py --port COM5 --dry-run     # print, don't POST
"""
import argparse
import json
import sys
import time

import requests
import serial  # pyserial

REQUIRED = ("sensor_id", "location", "gas_ohm")
OPTIONAL = ("temp_c", "rh", "pressure_hpa", "t")


def ts() -> str:
    return time.strftime("%H:%M:%S")


def parse_line(raw: bytes):
    """Return (payload_dict, None) or (None, reason)."""
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        return None, "empty"
    if text.startswith("#"):
        return None, "comment: " + text[1:].strip()
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return None, "malformed: " + text[:80]
    if not isinstance(obj, dict):
        return None, "not an object"
    missing = [k for k in REQUIRED if k not in obj]
    if missing:
        return None, "missing keys " + ",".join(missing)
    g = obj["gas_ohm"]
    if isinstance(g, bool) or not isinstance(g, (int, float)) or not g > 0:
        return None, f"bad gas_ohm {g!r}"
    payload = {k: obj[k] for k in REQUIRED}
    for k in OPTIONAL:
        if k in obj:
            payload[k] = obj[k]
    return payload, None


def post(session: requests.Session, url: str, payload: dict) -> str:
    try:
        r = session.post(url, json=payload, timeout=3, headers={"x-sous-source": "serial"})
        return f"HTTP {r.status_code}"
    except requests.RequestException as e:
        return f"HTTP error ({type(e).__name__})"


def run(args) -> None:
    url = args.server.rstrip("/") + "/api/sensor/reading"
    session = requests.Session()
    while True:
        try:
            with serial.Serial(args.port, args.baud, timeout=2) as ser:
                print(f"{ts()} opened {args.port} @ {args.baud}", flush=True)
                # Boards often reset when the port opens; discard partial lines.
                ser.reset_input_buffer()
                while True:
                    raw = ser.readline()
                    if not raw:
                        continue  # timeout, no data yet
                    payload, why = parse_line(raw)
                    if payload is None:
                        if why not in ("empty",):
                            print(f"{ts()} skip ({why})", flush=True)
                        continue
                    result = "dry-run" if args.dry_run else post(session, url, payload)
                    print(
                        f"{ts()} {payload['sensor_id']}@{payload['location']} "
                        f"gas={payload['gas_ohm']:.0f} ohm "
                        f"T={payload.get('temp_c')} RH={payload.get('rh')} -> {result}",
                        flush=True,
                    )
        except serial.SerialException as e:
            print(f"{ts()} serial error: {e}; retrying in {args.retry}s", flush=True)
            time.sleep(args.retry)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", required=True, help="serial port, e.g. /dev/ttyUSB0, /dev/cu.usbserial-0001, COM5")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--server", default="http://localhost:8000", help="Sous backend base URL")
    ap.add_argument("--retry", type=float, default=2.0, help="seconds between serial reconnect attempts")
    ap.add_argument("--dry-run", action="store_true", help="parse and log readings but do not POST")
    args = ap.parse_args()
    try:
        run(args)
    except KeyboardInterrupt:
        print("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
