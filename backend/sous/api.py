"""FastAPI app wiring the world, the senses and the brain together. See ../../CONTRACT.md."""
from __future__ import annotations

import asyncio
import itertools
import json
import os
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .agent import llm, tts
from .agent.brain import Brain
from .senses.demo_audio import soundtrack_truth, soundtrack_wav
from .senses.hearing import HearingClassifier
from .senses.smell import Reading, SmellPipeline, SmellSimulator
from .sim.world import World

app = FastAPI(title="Sous", version="0.1")


class Hub:
    """Owns all state and fans messages out to websocket clients."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.events: list[dict] = []
        self._eseq = itertools.count(1)
        self.world = World(on_event=self._world_event)
        self.nose = SmellPipeline(on_event=self._smell_event)
        self.sim = SmellSimulator(self.nose)
        self.ears = HearingClassifier(on_event=self._hearing_event)
        self.brain = Brain(self.world, self.nose, self.ears, emit_action=self._action, speak=self._speak,
                           emit_event=self._raw_event)
        self._loop_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------ fan-out
    def _send_all(self, msg: dict) -> None:
        data = json.dumps(msg)
        dead = []
        for ws in list(self.clients):
            try:
                asyncio.ensure_future(ws.send_text(data))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def _raw_event(self, ev: dict) -> None:
        ev.setdefault("id", f"e{next(self._eseq)}")
        ev.setdefault("t", time.strftime("%Y-%m-%dT%H:%M:%S"))
        ev.setdefault("data", {})
        self.events.insert(0, ev)
        del self.events[200:]
        self._send_all({"type": "event", "event": ev})

    def _world_event(self, ev: dict) -> None:
        self._raw_event(ev)
        self.brain.on_world_event(ev)

    def _smell_event(self, ev: dict) -> None:
        self._raw_event(ev)
        self.brain.on_smell_event(ev)

    def _hearing_event(self, ev: dict) -> None:
        self._raw_event(ev)
        self.brain.on_hearing_event(ev)

    def _action(self, a: dict) -> None:
        self._send_all({"type": "action", "action": a})

    async def _speak(self, text: str) -> None:
        self._send_all({"type": "speak", "text": text, "id": f"s{int(time.time()*1000)}"})

    # ------------------------------------------------------------ state
    def state(self) -> dict:
        w = self.world.snapshot()
        hearing = self.ears.snapshot()
        hearing["recent"] = [e for e in self.events if e["sense"] == "hearing"][:10]
        return {
            "clock": time.strftime("%Y-%m-%dT%H:%M:%S"),
            **w,
            "senses": {"hearing": hearing, "smell": self.nose.snapshot()},
            "voice": {"last_line": self.brain.last_line, "muted": self.brain.muted},
            "actions": self.brain.actions,
            "providers": {"llm": llm.PROVIDER, "tts": tts.PROVIDER},
        }

    # ------------------------------------------------------------ main loop
    async def run(self) -> None:
        last = time.monotonic()
        last_snapshot = 0.0
        last_sim = 0.0
        while True:
            await asyncio.sleep(0.1)
            now = time.monotonic()
            dt, last = now - last, now
            self.world.tick(dt)
            self.ears.set_load(sum(1 for o in self.world.orders if o.status in ("queued", "fire", "cooking")))
            if now - last_sim >= 1.0:
                last_sim = now
                self.sim.step()
                self.nose.tick()
            try:
                await self.brain.tick()
            except Exception as e:  # never let a brain bug stop the sim
                self._raw_event({"sense": "agent", "kind": "error", "label": "agent error", "detail": str(e),
                                 "severity": "warn"})
            if now - last_snapshot >= 1.0:
                last_snapshot = now
                self._send_all({"type": "snapshot", "state": self.state()})

    def reset(self) -> None:
        self.world.reset()
        self.nose.reset()
        self.sim = SmellSimulator(self.nose)
        if os.environ.get("SOUS_NOSE_AUTOSTART", "1") == "1":
            self.sim.set_scenario("nominal")
        self.ears.reset()
        self.brain.__init__(self.world, self.nose, self.ears, emit_action=self._action, speak=self._speak,
                            emit_event=self._raw_event)
        self.events.clear()


hub = Hub()


@app.on_event("startup")
async def _start() -> None:
    # The nose simulator starts in clean-air mode so the sensor is warm and "online" by the time
    # the demo begins. A real board posting to /api/sensor/reading takes over automatically.
    if os.environ.get("SOUS_NOSE_AUTOSTART", "1") == "1":
        hub.sim.set_scenario("nominal")
    hub._loop_task = asyncio.create_task(hub.run())


# ---------------------------------------------------------------- REST
class Control(BaseModel):
    rush: Optional[bool] = None
    muted: Optional[bool] = None
    speed: Optional[float] = None


class Scenario(BaseModel):
    name: str


class SensorReading(BaseModel):
    sensor_id: str = "esp32-01"
    location: str = "walk-in"
    gas_ohm: float
    temp_c: Optional[float] = None
    rh: Optional[float] = None
    pressure_hpa: Optional[float] = None
    t: Optional[float] = None


class Inject(BaseModel):
    kind: str


class Speak(BaseModel):
    text: str


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "providers": {"llm": llm.PROVIDER, "tts": tts.PROVIDER},
            "smell_device": hub.nose.device}


@app.get("/api/state")
async def state() -> dict:
    return hub.state()


@app.post("/api/control")
async def control(c: Control) -> dict:
    if c.rush is not None:
        hub.world.rush = c.rush
        hub._raw_event({"sense": "orders", "kind": "rush", "label": "Rush on" if c.rush else "Rush off",
                        "detail": "", "severity": "info"})
    if c.muted is not None:
        hub.brain.muted = c.muted
    if c.speed is not None:
        hub.world.speed = max(0.25, min(8.0, c.speed))
    return {"rush": hub.world.rush, "muted": hub.brain.muted, "speed": hub.world.speed}


@app.post("/api/reset")
async def reset() -> dict:
    hub.reset()
    return {"ok": True}


@app.post("/api/menu/{mid}/restore")
async def restore(mid: str) -> dict:
    if mid not in hub.world.menu:
        raise HTTPException(404, "no such item")
    hub.brain.human_restore(mid)
    hub._raw_event({"sense": "agent", "kind": "override", "label": f"Staff: we got more {hub.world.menu[mid].name}",
                    "detail": "menu restored, stock reset to par", "severity": "info"})
    return {"ok": True}


@app.post("/api/smell/scenario")
async def scenario(s: Scenario) -> dict:
    try:
        hub.sim.set_scenario(s.name)
    except ValueError:
        raise HTTPException(400, f"unknown scenario {s.name}")
    return {"scenario": hub.sim.scenario}


@app.post("/api/sensor/reading")
async def sensor_reading(r: SensorReading, request: Request) -> dict:
    """The hardware endpoint. An ESP32 posts here at 1 Hz; so does the serial bridge; so does the simulator
    (in-process, same ``ingest``)."""
    # a real board posting takes precedence over the simulator
    if hub.sim.running:
        hub.sim.set_scenario("stop")
    source = "serial" if r.sensor_id.startswith("mq") or request.headers.get("x-sous-source") == "serial" else "http"
    hub.nose.ingest(Reading(t=r.t or time.time(), gas_ohm=r.gas_ohm, temp_c=r.temp_c, rh=r.rh,
                            sensor_id=r.sensor_id, location=r.location, source=source))
    return {"ok": True, "status": hub.nose.status, "ratio": hub.nose.ratio}


@app.post("/api/hearing/inject")
async def inject(i: Inject) -> dict:
    if i.kind not in ("ticket_burst", "fryer_alarm", "door_chime", "noise_spike"):
        raise HTTPException(400, "unknown kind")
    hub._hearing_event({"sense": "hearing", "kind": i.kind, "label": i.kind.replace("_", " ").title() + " (injected)",
                        "detail": "scripted fallback", "severity": "info", "data": {"injected": True}})
    return {"ok": True}


@app.get("/api/demo/soundtrack.wav")
async def soundtrack() -> Response:
    return Response(content=soundtrack_wav(), media_type="audio/wav")


@app.get("/api/demo/soundtrack.json")
async def soundtrack_json() -> dict:
    return soundtrack_truth()


@app.post("/api/speak")
async def speak(s: Speak) -> Response:
    audio = await tts.synthesize(s.text)
    if audio is None:
        return Response(status_code=204)
    return Response(content=audio, media_type="audio/mpeg")


# ---------------------------------------------------------------- websockets
@app.websocket("/ws")
async def ws_state(ws: WebSocket) -> None:
    await ws.accept()
    hub.clients.add(ws)
    try:
        await ws.send_text(json.dumps({"type": "snapshot", "state": hub.state()}))
        while True:
            await ws.receive_text()  # we ignore client messages; keeps the socket alive
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


@app.websocket("/ws/audio")
async def ws_audio(ws: WebSocket) -> None:
    await ws.accept()
    hub.ears.set_source("mic")
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("text"):
                try:
                    meta = json.loads(msg["text"])
                    hub.ears.set_source(meta.get("source", "mic"))
                except json.JSONDecodeError:
                    pass
            elif msg.get("bytes"):
                hub.ears.feed_int16(msg["bytes"])
    except WebSocketDisconnect:
        pass
    finally:
        hub.ears.set_source("none")


# ---------------------------------------------------------------- static frontend (after `npm run build`)
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="frontend")
