#!/usr/bin/env python3
"""Pre-render Sous's fixed voice lines with ElevenLabs into backend/voice_cache/.

The demo ships with these clips already rendered (voice "Deon M", id MVc9udK5w93ZDKCXnhBy).
Run this only if you change a line or want a different voice:

    ELEVENLABS_API_KEY=... python tools/render_voice_cache.py [--voice VOICE_ID]

Dynamic lines (fire calls with order ids, stockout lines with numbers) are synthesized at runtime
when ELEVENLABS_API_KEY is set, and fall back to the browser voice otherwise.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path

import httpx

LINES = [
    "Fryer alarm and nothing's on the fryer ticket. Someone check station 2.",
    "Nose says the avocado in the walk-in is turning. Pushing it today at 20 percent off and skipping tomorrow's order.",
    "Something's burning on the line. Check station 2 now.",
    "Nose spiked in the walk-in, looks like cleaner. Ignoring it for two minutes.",
    "Fryer oil's past its life. Change it before the dinner rush. Oil's cheaper than a bad review.",
    "Air's clear at the walk-in.",
    "Air's clear at the line.",
    "Air's clear at the fry station.",
    "Avocado is back. Restoring the menu.",
    "Door chime. Nothing on the pickup shelf.",
    "It's loud. Call your orders back so nothing gets missed.",
    "Nose picked up something in the walk-in I can't place. Can someone take a look?",
    "Avocado is about to run out. Pulling Avocado Toast, Guacamole and Chips and Breakfast Burrito from DoorDash and Uber Eats now, promoting Heirloom Tomato Toast at 15 percent off. Reorder draft is ready.",
    "Dasher at the door. Bag's on the shelf, check the name.",
    "Door chime. Nothing ready for pickup yet, let the Dasher know.",
    "Fries up. Match them to the ticket.",
    "Heard a ticket print. Adding it to the board.",
]

CACHE = Path(__file__).resolve().parents[1] / "backend" / "voice_cache"


def key(text: str) -> str:
    return hashlib.sha1(text.strip().lower().encode()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default=os.environ.get("ELEVENLABS_VOICE_ID", "MVc9udK5w93ZDKCXnhBy"))
    ap.add_argument("--model", default="eleven_turbo_v2_5")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        print("ELEVENLABS_API_KEY not set", file=sys.stderr)
        return 1
    CACHE.mkdir(exist_ok=True)
    with httpx.Client(timeout=30) as c:
        for line in LINES:
            out = CACHE / f"{key(line)}.mp3"
            if out.exists() and not a.force:
                print("skip  ", line)
                continue
            r = c.post(f"https://api.elevenlabs.io/v1/text-to-speech/{a.voice}",
                       headers={"xi-api-key": api_key, "accept": "audio/mpeg"},
                       json={"text": line, "model_id": a.model,
                             "voice_settings": {"stability": 0.55, "similarity_boost": 0.75}})
            r.raise_for_status()
            out.write_bytes(r.content)
            print("render", line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
