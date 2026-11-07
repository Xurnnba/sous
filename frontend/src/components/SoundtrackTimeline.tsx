import type { Event, SoundtrackTruth } from "../types";

const kindColor: Record<string, string> = {
  door_chime: "bg-sky-400",
  ticket_burst: "bg-accent",
  fryer_alarm: "bg-bad",
  noise_spike: "bg-warn",
  speech: "bg-fuchsia-400",
};

/**
 * Ground-truth markers (top row) vs. detections heard on /ws during this playback (bottom row).
 * `detections` are hearing events with a `t` after `startedAt`.
 */
export function SoundtrackTimeline({ truth, position, duration, detections, startedAt, finished = false }: { truth: SoundtrackTruth | null; position: number; duration: number; detections: Event[]; startedAt: number | null; finished?: boolean }) {
  const total = duration || truth?.duration_s || 75;
  // After playback the hook resets position to 0; park the cursor at the end instead.
  const cursor = finished ? total : position;
  const showCursor = duration > 0 || finished;
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / total) * 100))}%`;
  const detected = startedAt
    ? detections.filter((e) => new Date(e.t).getTime() >= startedAt).map((e) => ({ t: (new Date(e.t).getTime() - startedAt) / 1000, kind: e.kind }))
    : [];
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] uppercase tracking-widest text-zinc-500">
        <span>Ground truth</span>
        <span className="num">{finished ? `done · ${total.toFixed(0)} s` : `${position.toFixed(1)}s / ${total.toFixed(0)}s`}</span>
      </div>
      <div className="relative h-3 rounded bg-ink-700">
        {truth?.events.map((e, i) => (
          <span key={i} title={`${e.label ?? e.kind} @ ${e.t}s`} className={`absolute top-0 h-full w-1 rounded ${kindColor[e.kind] ?? "bg-zinc-300"}`} style={{ left: pct(e.t) }} />
        ))}
        {showCursor && <span className="absolute top-[-2px] h-[calc(100%+4px)] w-0.5 bg-zinc-100" style={{ left: pct(cursor) }} />}
      </div>
      <div className="text-[10px] uppercase tracking-widest text-zinc-500">Detected</div>
      <div className="relative h-3 rounded bg-ink-700">
        {detected.map((e, i) => (
          <span key={i} title={`${e.kind} @ ${e.t.toFixed(1)}s`} className={`absolute top-0 h-full w-1 rounded ${kindColor[e.kind] ?? "bg-zinc-300"}`} style={{ left: pct(e.t) }} />
        ))}
        {showCursor && <span className="absolute top-[-2px] h-[calc(100%+4px)] w-0.5 bg-zinc-100" style={{ left: pct(cursor) }} />}
      </div>
      <div className="flex flex-wrap gap-3 pt-1">
        {Object.entries(kindColor).map(([k, c]) => (
          <span key={k} className="inline-flex items-center gap-1 text-[10px] text-zinc-400">
            <span className={`w-2 h-2 rounded-sm ${c}`} /> {k.replace("_", " ")}
          </span>
        ))}
      </div>
      {!truth && <p className="text-xs text-zinc-500">Ground-truth markers load from /api/demo/soundtrack.json.</p>}
    </div>
  );
}
