"""Drive the running backend like a browser would: stream the soundtrack as a mic, teach a sound,
fire nose scenarios, turn on rush; print the items that result. Run with the server on :8000."""
import asyncio, io, json, time, wave, sys
import numpy as np, requests, websockets
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sous.senses.ear import sounds

BASE = "http://localhost:8000"; WS = "ws://localhost:8000"

async def stream(sig, mic="e2e", location="kitchen", rate=1.0, source="soundtrack"):
    pcm = (np.clip(sig, -1, 1) * 32767).astype("<i2").tobytes()
    async with websockets.connect(f"{WS}/ws/audio?mic={mic}&location={location}&source={source}") as a:
        for i in range(0, len(pcm), 8000):
            await a.send(pcm[i:i + 8000]); await asyncio.sleep(0.25 / rate)
        await asyncio.sleep(1.0)

async def main():
    requests.post(f"{BASE}/api/reset")
    got = {"events": [], "items": [], "speak": []}
    async def listener():
        async with websockets.connect(f"{WS}/ws") as s:
            async for m in s:
                d = json.loads(m)
                if d["type"] == "event" and d["event"]["sense"] in ("hearing", "smell"): got["events"].append(d["event"])
                if d["type"] == "item": got["items"].append((d["change"], d["item"]))
                if d["type"] == "speak": got["speak"].append(d["text"])
    lt = asyncio.create_task(listener())
    await asyncio.sleep(1)

    print("== 1. zero-shot: soundtrack streamed as the kitchen mic (3x speed)")
    with wave.open(io.BytesIO(sounds.soundtrack_wav())) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    await stream(x * 0.3, rate=3.0)   # quieter, like across a room
    for e in got["events"]:
        if e["sense"] == "hearing": print(f"   {e['kind']:13s} {e['data'].get('how','')} {e['data'].get('confidence','')} top={e['data'].get('top',[['']])[0][0]}")
    truth = {k["kind"] for k in sounds.soundtrack_truth()["events"]}
    seen = {e["kind"] for e in got["events"] if e["sense"] == "hearing"}
    print("   kinds expected:", sorted(truth), " detected:", sorted(seen & truth), " missed:", sorted(truth - seen))

    print("== 2. teach the printer through the mic, then play it again")
    clip = sounds.load_clip("ticket_printer")
    async def teach_and_play():
        bed = np.random.default_rng(1).normal(0, 1, 16000 * 3).astype(np.float32) * 0.003
        sig = np.concatenate([bed, clip * 0.3, clip * 0.3, bed[:16000]])
        t = asyncio.create_task(stream(sig, mic="e2e", rate=1.0))
        await asyncio.sleep(2.5)
        r = requests.post(f"{BASE}/api/ear/teach", json={"label": "ticket_burst", "mic": "e2e", "seconds": 6.5}); print("   teach:", r.json())
        await t
    await teach_and_play()
    protos = requests.get(f"{BASE}/api/ear/prototypes").json(); print("   prototypes:", protos)
    n_before = len(got["events"])
    await stream(np.concatenate([np.zeros(16000), clip * 0.25, np.zeros(16000)]), mic="e2e")
    for e in got["events"][n_before:]:
        if e["sense"] == "hearing": print(f"   replay -> {e['kind']} {e['data'].get('how')} {e['data'].get('confidence')}")

    print("== 3. nose scenarios")
    for name in ("spoilage_walkin", "burning", "cleaning", "nominal"):
        n = len(got["events"]); requests.post(f"{BASE}/api/smell/scenario", json={"name": name}); await asyncio.sleep(18)
        print(f"   {name:16s} ->", [(e['kind'], e['data'].get('urgency'), e['data'].get('confidence')) for e in got['events'][n:] if e['sense']=='smell'])

    print("== 4. rush for 70 s")
    requests.post(f"{BASE}/api/control", json={"rush": True, "speed": 1}); await asyncio.sleep(70)

    snap = requests.get(f"{BASE}/api/items").json()
    print("== items open:", snap["counts"])
    for it in snap["open"]: print(f"   [{it['urgency']:5s}] {it['sense']:7s} x{it['count']} {it['title']}" + (f"  | Sous did: {it['auto']['summary']}" if it['auto'] else ""))
    print("== recently closed:", [(i['title'][:40], i['closed_by']) for i in snap['recent_closed'][:6]])
    print("== spoken:"); [print("   -", s) for s in got["speak"]]
    if snap["open"]:
        r = requests.post(f"{BASE}/api/items/{snap['open'][0]['id']}/done"); print("== done ->", r.json()["status"])
    lt.cancel()
asyncio.run(main())
