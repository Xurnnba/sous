# Sous — frontend

React 18 + Vite 5 + TypeScript + Tailwind 3 front end for **Sous**, the kitchen's other senses.
Charts use `recharts`, icons use `lucide-react`; nothing else.

## Run

```bash
cd frontend
npm i
npm run dev            # http://localhost:5173
npm run build          # type-checks (tsc) then bundles to dist/
```

### Mock mode (no backend needed)

```
http://localhost:5173/?mock=1
```

`?mock=1` swaps the WebSocket + REST layer for an in-browser simulator (`src/mock/mockBackend.ts`) that
emits the exact `WsMessage` shapes from `CONTRACT.md` once per second: orders arriving and moving through
queued → fire → cooking → ready, avocado burning toward stockout (menu item hidden, substitute promoted,
reorder drafted), a walk-in spoilage VOC anomaly starting ~15 s in, hearing events every few seconds, and
`speak` lines. Every control (Rush, Reset, scenarios, inject, restore, speed) works against the mock.
The demo soundtrack is synthesised locally in mock mode since `/api/demo/*` is unavailable.

Views are tabs in the top nav and tracked in the URL hash: `#/kitchen`, `#/storefront`, `#/backoffice`, `#/senses`.

## How it talks to the backend

`vite.config.ts` proxies `/api` → `http://localhost:8000` and `/ws` → `ws://localhost:8000` (WebSocket).
Start FastAPI on :8000 and open `http://localhost:5173/` without `?mock=1`.

| Piece | File | What it does |
|---|---|---|
| State + feed | `src/hooks/useSous.tsx` | Opens `/ws`, keeps latest `State`, rolling `Event[]`/`Action[]` (120 each), reconnects with exponential backoff (0.5 s → 10 s), fans out `speak` frames. Exposes `api` with a helper for every POST in the contract (`src/lib/api.ts`). |
| Voice | `src/hooks/useVoice.ts` | Serial queue. For each `speak` frame: `POST /api/speak` → play `audio/mpeg`; on `204` fall back to `speechSynthesis` (English voice, rate 1.05). Never overlaps. Mute calls `POST /api/control {muted}`. |
| Ears | `src/hooks/useAudioStream.ts` | Mic (`getUserMedia`) or the demo soundtrack (`GET /api/demo/soundtrack.wav`, played through the speakers). Either is resampled in-browser to 16 kHz mono Int16 via AudioWorklet (ScriptProcessor fallback) and sent as 250 ms binary frames to `/ws/audio` after the text header `{"source","sample_rate":16000}`. Ground truth from `/api/demo/soundtrack.json` is drawn against detections on the Senses tab. |
| Types | `src/types.ts` | 1:1 with `CONTRACT.md`. |

## Layout

```
src/
  App.tsx                   shell: nav, control bar, views, voice bar
  types.ts                  contract types
  lib/api.ts                REST client (+ isMockMode)
  lib/format.ts             money/time/colour helpers
  hooks/useSous.tsx         provider + hook (WS or mock)
  hooks/useVoice.ts         speak queue
  hooks/useAudioStream.ts   mic / soundtrack -> /ws/audio
  mock/mockBackend.ts       in-browser simulator
  components/               ControlBar, TopNav, VoiceBar, EventFeed, Gauges, SoundtrackTimeline, common
  views/                    Kitchen, Storefront, BackOffice, Senses
```
