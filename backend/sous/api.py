"""FastAPI app wiring the world, the senses and the agent together. See ../../CONTRACT.md."""
from __future__ import annotations

import asyncio
import itertools
import json
import os
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .agent import llm, tts
from .agent.brain import Brain
from .agent.items import ItemStore
from .senses.ear import embedder, sounds
from .senses.ear.streams import EarManager
from .senses.nose.physics import Simulator as NoseSimulator
from .senses.nose.pipeline import NosePipeline
from .senses.nose.room import ScentRoom
from .sim.world import World

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Sous", version="0.2")


class Hub:
    """Owns all state and fans messages out to websocket clients."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.events: list[dict] = []
        self._eseq = itertools.count(1)
        self.world = World(on_event=self._world_event)
        self.nose = NosePipeline(on_event=self._smell_event)
        self.nose_sim = NoseSimulator(self.nose)
        # scent-room demo: four virtual noses sharing the single nose's model (loaded lazily on first step)
        self.room = ScentRoom(self.world, on_event=self._smell_event, model_provider=self.nose._ensure_model)
        self.ears = EarManager(DATA_DIR, on_event=self._hearing_event)
        self.items = ItemStore(DATA_DIR / "items.json", on_change=self._item_change)
        self.brain = Brain(self.world, self.nose, self.ears, self.items, emit_action=self._action,
                           speak=self._speak, emit_event=self._raw_event)
        self.brain.room_reset()      # room air does not survive a restart; neither do its Board items
        self.stress = 0.0
        self._loop_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------ fan-out
    def _send_all(self, msg: dict) -> None:
        data = json.dumps(msg)
        for ws in list(self.clients):
            async def _send(w=ws):
                try:
                    await w.send_text(data)
                except Exception:
                    self.clients.discard(w)      # client went away mid-send; not an error worth logging
            asyncio.ensure_future(_send())

    def _raw_event(self, ev: dict) -> None:
        ev.setdefault("id", f"e{next(self._eseq)}")
        ev.setdefault("t", time.strftime("%Y-%m-%dT%H:%M:%S"))
        ev.setdefault("data", {})
        self.events.insert(0, ev)
        del self.events[300:]
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

    def _item_change(self, item: dict, change: str) -> None:
        self._send_all({"type": "item", "change": change, "item": item})

    async def _speak(self, text: str) -> None:
        self._send_all({"type": "speak", "text": text, "id": f"s{int(time.time() * 1000)}"})

    # ------------------------------------------------------------ state
    def _compute_stress(self) -> float:
        open_tickets = sum(1 for o in self.world.orders if o.status in ("queued", "fire", "cooking"))
        above_floor, speech = self.ears.stress_inputs()
        audio = min(1.0, max(0.0, (above_floor - 6) / 24)) * 0.6 + speech * 0.4 if self.ears.active else 0.0
        load = min(1.0, open_tickets / 12)
        return round(max(audio, load), 2)

    def state(self) -> dict:
        w = self.world.snapshot()
        ears = self.ears.snapshot()
        hearing_recent = [e for e in self.events if e["sense"] == "hearing" and e["kind"] not in
                          ("mic_online", "mic_offline")][:12]
        return {
            "clock": time.strftime("%Y-%m-%dT%H:%M:%S"),
            **w,
            "senses": {
                "hearing": {"active": ears["active"], "source": "mic" if ears["active"] else "none",
                            "noise_db": max((m["level_db"] for m in ears["mics"]), default=-60.0),
                            "stress": self.stress, "recent": hearing_recent},
                "ears": ears,
                "smell": self.nose.snapshot(),
            },
            "room": self.room.snapshot(),
            "items": self.items.snapshot(),
            "voice": {"last_line": self.brain.last_line, "muted": self.brain.muted},
            "actions": self.brain.actions,
            "providers": {"llm": llm.PROVIDER, "tts": tts.PROVIDER, "ears": embedder.status(),
                          "nose": self.nose.snapshot().get("model", {}).get("name", "unknown")},
        }

    # ------------------------------------------------------------ main loop
    async def run(self) -> None:
        last = time.monotonic()
        last_snapshot = last_sim = 0.0
        while True:
            await asyncio.sleep(0.1)
            now = time.monotonic()
            dt, last = now - last, now
            self.world.tick(dt)
            if now - last_sim >= 1.0:
                last_sim = now
                self.nose_sim.step()
                self.nose.tick()
                try:
                    self.room.step()
                except Exception as e:  # the demo room must never stop the main loop
                    self._raw_event({"sense": "smell", "kind": "error", "label": "scent room error",
                                     "detail": str(e), "severity": "warn"})
                self.ears.tick()
                self.items.tick()
                self.stress = self._compute_stress()
            try:
                await self.brain.tick()
            except Exception as e:  # never let a brain bug stop the sim
                self._raw_event({"sense": "agent", "kind": "error", "label": "agent error", "detail": str(e),
                                 "severity": "warn"})
            if now - last_snapshot >= 1.0:
                last_snapshot = now
                self._send_all({"type": "snapshot", "state": self.state()})

    def reset(self, keep_calibration: bool = True) -> None:
        self.world.reset()
        self.nose.reset()
        self.nose_sim = NoseSimulator(self.nose)
        if os.environ.get("SOUS_NOSE_AUTOSTART", "1") == "1":
            self.nose_sim.set_scenario("nominal")
        self.room.reset_all()        # sources and inference log go; room noses keep calibration
        self.items.clear()
        self.brain = Brain(self.world, self.nose, self.ears, self.items, emit_action=self._action,
                           speak=self._speak, emit_event=self._raw_event)
        self.events.clear()


hub = Hub()


@app.on_event("startup")
async def _start() -> None:
    if os.environ.get("SOUS_NOSE_AUTOSTART", "1") == "1":
        hub.nose_sim.set_scenario("nominal")
    threading.Thread(target=embedder.load, daemon=True).start()   # warm the ear model off the loop
    hub._loop_task = asyncio.create_task(hub.run())


# ---------------------------------------------------------------- models
class Control(BaseModel):
    rush: Optional[bool] = None
    muted: Optional[bool] = None
    speed: Optional[float] = None


class Scenario(BaseModel):
    name: str


class SensorReading(BaseModel):
    sensor_id: str = "esp32-01"
    location: str = "walk-in"
    gas_ohm: Optional[float] = None
    gas_ohm_steps: Optional[list[float]] = None
    temp_c: Optional[float] = None
    rh: Optional[float] = None
    pressure_hpa: Optional[float] = None
    t: Optional[float] = None


class Inject(BaseModel):
    kind: str
    location: str = "kitchen"


class Teach(BaseModel):
    label: str
    mic: Optional[str] = None
    seconds: float = 4.0


class Speak(BaseModel):
    text: str


class RoomSource(BaseModel):
    kind: str
    x: float
    y: float


class RoomMove(BaseModel):
    x: float
    y: float


# ---------------------------------------------------------------- REST
@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "providers": hub.state()["providers"], "smell_device": hub.nose.snapshot().get("device"),
            "mics": len(hub.ears.mics)}


@app.get("/api/hosts")
async def hosts(request: Request) -> dict:
    """LAN addresses of this server, so a phone can reach the sound board when the laptop opened localhost."""
    import socket
    port = request.url.port or 8000
    ips: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        if not ip.startswith("127.") and ip not in ips:
            ips.insert(0, ip)
    except Exception:
        pass
    return {"port": port, "hosts": [{"ip": ip, "url": f"http://{ip}:{port}/#/sounds"} for ip in ips],
            "proxy": await _proxy_url(request, port)}


_reflection: dict = {}


async def _proxy_url(request: Request, port: int) -> Optional[dict]:
    """The exe.dev HTTPS proxy URL phones should use (https://exe.dev/docs/proxy.md).

    The VM's name and default proxy port come from the documented Reflection endpoint
    (https://exe.dev/docs/integrations-reflection.md). The default port is the only one exe.dev can
    make public, at https://<name>.exe.xyz/ with no port; any other port is reachable only by people
    with access to the VM. Without Reflection, fall back to the X-Forwarded-Host the proxy sent."""
    if "name" not in _reflection:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=2.0) as c:
                idx = (await c.get("https://reflection.int.exe.xyz/")).json()
                dp = (await c.get("https://reflection.int.exe.xyz/default_port")).json()
            _reflection.update(name=idx.get("name"), default_port=dp.get("default_port"))
        except Exception:
            _reflection.update(name=None, default_port=None)
    name, default_port = _reflection.get("name"), _reflection.get("default_port")
    if name:
        if default_port == port:
            return {"url": f"https://{name}.exe.xyz/", "vm": name, "default_port": True}
        return {"url": f"https://{name}.exe.xyz:{port}/", "vm": name, "default_port": False}
    fwd = request.headers.get("x-forwarded-host")
    if fwd and fwd.split(":")[0].endswith(".exe.xyz"):
        host = fwd.split(":")[0]
        return {"url": f"https://{fwd}/", "vm": host.split(".")[0], "default_port": ":" not in fwd}
    return None


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


# ---- items
@app.get("/api/items")
async def items() -> dict:
    return hub.items.snapshot()


@app.post("/api/items/{iid}/done")
async def item_done(iid: str) -> dict:
    it = hub.items.close(iid, "done")
    if not it:
        raise HTTPException(404, "no open item")
    return it


@app.post("/api/items/{iid}/dismiss")
async def item_dismiss(iid: str) -> dict:
    it = hub.items.close(iid, "dismissed")
    if not it:
        raise HTTPException(404, "no open item")
    return it


# ---- nose
@app.post("/api/smell/scenario")
async def scenario(s: Scenario) -> dict:
    try:
        hub.nose_sim.set_scenario(s.name)
    except (ValueError, KeyError):
        raise HTTPException(400, f"unknown scenario {s.name}")
    return {"scenario": getattr(hub.nose_sim, "scenario", s.name)}


@app.post("/api/sensor/reading")
async def sensor_reading(r: SensorReading, request: Request) -> dict:
    """The hardware endpoint. An ESP32 posts here at 1 Hz; so does the serial bridge; so does the simulator
    (in-process, same ``ingest``)."""
    if getattr(hub.nose_sim, "running", False):
        hub.nose_sim.set_scenario("stop")
    if r.gas_ohm is None and not r.gas_ohm_steps:
        raise HTTPException(400, "gas_ohm or gas_ohm_steps required")
    source = "serial" if request.headers.get("x-sous-source") == "serial" or r.sensor_id.startswith("mq") else "http"
    reading = {"t": r.t or time.time(), "gas_ohm": r.gas_ohm, "gas_ohm_steps": r.gas_ohm_steps, "temp_c": r.temp_c,
               "rh": r.rh, "sensor_id": r.sensor_id, "location": r.location, "source": source}
    hub.nose.ingest(reading)
    snap = hub.nose.snapshot()
    return {"ok": True, "status": snap.get("status"), "ratios": snap.get("ratios")}


# ---- scent room (docs/SCENT_ROOM.md)
@app.get("/api/room")
async def room_get() -> dict:
    return {"layout": hub.room.layout(), "palette": hub.room.palette(), "state": hub.room.snapshot()}


@app.post("/api/room/source")
async def room_add(s: RoomSource) -> dict:
    try:
        return hub.room.add_source(s.kind, s.x, s.y)
    except ValueError:
        raise HTTPException(400, f"unknown kind {s.kind}")
    except OverflowError as e:
        raise HTTPException(400, str(e))


@app.post("/api/room/source/{sid}/move")
async def room_move(sid: str, m: RoomMove) -> dict:
    src = hub.room.move_source(sid, m.x, m.y)
    if src is None:
        raise HTTPException(404, "no such source")
    return src


@app.delete("/api/room/source/{sid}")
async def room_remove(sid: str) -> dict:
    if not hub.room.remove_source(sid):
        raise HTTPException(404, "no such source")
    return {"ok": True}


@app.post("/api/room/reset")
async def room_reset() -> dict:
    hub.room.reset()
    hub.brain.room_reset()
    return {"ok": True}


# ---- ears
@app.post("/api/ear/teach")
async def ear_teach(t: Teach) -> dict:
    if not hub.ears.teach(t.mic, t.label, t.seconds):
        raise HTTPException(400, "no microphone connected or unknown label")
    return {"ok": True, "label": t.label, "seconds": t.seconds}


@app.get("/api/ear/prototypes")
async def ear_protos() -> dict:
    return {"prototypes": hub.ears.protos.summary()}


@app.delete("/api/ear/prototypes/{label}")
async def ear_forget(label: str) -> dict:
    """Forget one taught label, or everything with label ``_all`` (fresh calibration before a demo)."""
    if label == "_all":
        for k in list(hub.ears.protos.protos):
            hub.ears.protos.forget(k)
        hub.ears._rooms.clear()
        hub.ears._save_rooms()
        for c in hub.ears._cache.values():
            c._noise_mag = None
            c._noise_frames.clear()
    else:
        hub.ears.protos.forget(label)
    return {"ok": True, "prototypes": hub.ears.protos.summary()}


@app.post("/api/hearing/inject")
async def inject(i: Inject) -> dict:
    if i.kind not in ("ticket_burst", "fryer_alarm", "door_chime", "phone_ring", "clatter"):
        raise HTTPException(400, "unknown kind")
    hub._hearing_event({"sense": "hearing", "kind": i.kind, "label": i.kind.replace("_", " ").title() + " (injected)",
                        "detail": "scripted fallback", "severity": "info",
                        "data": {"injected": True, "location": i.location, "mic": "inject", "how": "injected",
                                 "confidence": 1.0, "top": [["injected", 1.0]], "burst_30s": 1}})
    return {"ok": True}


# ---- sounds (sound board + soundtrack)
@app.get("/api/sounds")
async def sound_list() -> dict:
    return {"clips": sounds.available()}


@app.get("/api/sounds/{cid}.wav")
async def sound_file(cid: str) -> Response:
    if cid not in sounds.BY_ID or not sounds.clip_path(cid).exists():
        raise HTTPException(404, "no such clip")
    return FileResponse(str(sounds.clip_path(cid)), media_type="audio/wav")


@app.get("/api/demo/soundtrack.wav")
async def soundtrack() -> Response:
    return Response(content=sounds.soundtrack_wav(), media_type="audio/wav")


@app.get("/api/demo/soundtrack.json")
async def soundtrack_json() -> dict:
    return sounds.soundtrack_truth()


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
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


@app.websocket("/ws/audio")
async def ws_audio(ws: WebSocket) -> None:
    """Binary Int16 16 kHz mono frames. Query params or the first text frame set mic id, location, source."""
    await ws.accept()
    q = ws.query_params
    mic_id = q.get("mic") or f"mic-{int(time.time() * 1000) % 100000}"
    location = q.get("location", "kitchen")
    source = q.get("source", "mic")
    hub.ears.open(mic_id, location, source)
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("text"):
                try:
                    meta = json.loads(msg["text"])
                    new_loc = meta.get("location", location)
                    new_src = meta.get("source", source)
                    if new_loc != location or new_src != source:
                        location, source = new_loc, new_src
                        hub.ears.open(mic_id, location, source)
                except json.JSONDecodeError:
                    pass
            elif msg.get("bytes"):
                hub.ears.feed(mic_id, msg["bytes"])
    except WebSocketDisconnect:
        pass
    finally:
        hub.ears.close(mic_id)


# ---------------------------------------------------------------- static frontend (after `npm run build`)
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="frontend")
