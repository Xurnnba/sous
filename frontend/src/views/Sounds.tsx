import { Shuffle, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSous } from "../hooks/useSous";
import type { Event, SoundClip } from "../types";

const HEAR_WINDOW_MS = 4000;
const GIVE_UP_MS = 5000;
const SEQUENCE_GAP_MS = 6000;
const SEQUENCE_LEN = 5;

type Feedback = { status: "waiting" | "heard" | "missed"; text: string; at: number };

/**
 * Phone page: one big button per clip. Tapping plays the wav locally (user gesture) and the
 * laptop's mic hears it; when a hearing event of that kind arrives within 4 s the button goes green.
 */
export function Sounds() {
  const { api, onEvent, mock } = useSous();
  const [clips, setClips] = useState<SoundClip[] | null>(null);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [sequence, setSequence] = useState<{ step: number; total: number } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pending = useRef<Map<string, { kind: string; at: number; timer: number }>>(new Map());
  const seqTimers = useRef<number[]>([]);

  useEffect(() => {
    api
      .sounds()
      .then((r) => setClips(r.clips ?? []))
      .catch(() => setClips([]));
  }, [api]);

  // Live feedback from the WS: match hearing events to recent taps by kind.
  useEffect(
    () =>
      onEvent((e: Event) => {
        if (e.sense !== "hearing") return;
        const now = Date.now();
        for (const [clipId, p] of pending.current) {
          if (p.kind !== e.kind || now - p.at > HEAR_WINDOW_MS) continue;
          window.clearTimeout(p.timer);
          pending.current.delete(clipId);
          const loc = typeof e.data?.location === "string" ? e.data.location : "kitchen";
          const conf = typeof e.data?.confidence === "number" ? ` · ${Math.round(e.data.confidence * 100)}%` : "";
          setFeedback((f) => ({ ...f, [clipId]: { status: "heard", text: `Heard at ${loc}${conf}`, at: now } }));
        }
      }),
    [onEvent],
  );

  const play = useCallback((clip: SoundClip) => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.src = clip.url;
      el.currentTime = 0;
      void el.play().catch(() => undefined);
    }
    const prev = pending.current.get(clip.id);
    if (prev) window.clearTimeout(prev.timer);
    const at = Date.now();
    const timer = window.setTimeout(() => {
      pending.current.delete(clip.id);
      setFeedback((f) => (f[clip.id]?.at === at ? { ...f, [clip.id]: { status: "missed", text: "not heard", at } } : f));
    }, GIVE_UP_MS);
    pending.current.set(clip.id, { kind: clip.kind, at, timer });
    setFeedback((f) => ({ ...f, [clip.id]: { status: "waiting", text: "listening…", at } }));
  }, []);

  const stopSequence = useCallback(() => {
    seqTimers.current.forEach((t) => window.clearTimeout(t));
    seqTimers.current = [];
    setSequence(null);
  }, []);

  const playSequence = useCallback(() => {
    if (!clips?.length) return;
    stopSequence();
    const available = clips.filter((c) => c.available);
    const picks = Array.from({ length: SEQUENCE_LEN }, () => available[Math.floor(Math.random() * available.length)]);
    setSequence({ step: 0, total: SEQUENCE_LEN });
    picks.forEach((clip, i) => {
      seqTimers.current.push(
        window.setTimeout(() => {
          setSequence({ step: i + 1, total: SEQUENCE_LEN });
          play(clip);
          if (i === SEQUENCE_LEN - 1) seqTimers.current.push(window.setTimeout(() => setSequence(null), GIVE_UP_MS));
        }, i * SEQUENCE_GAP_MS),
      );
    });
  }, [clips, play, stopSequence]);

  useEffect(() => () => stopSequence(), [stopSequence]);

  return (
    <div className="min-h-full w-full max-w-[480px] mx-auto px-4 py-5 flex flex-col gap-4">
      <audio ref={audioRef} preload="auto" />
      <header className="flex items-end justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-accent font-black">SOUS</div>
          <h1 className="text-2xl font-black leading-tight">Sous sound board</h1>
        </div>
        <a href="#/board" className="text-xs text-zinc-500 hover:text-zinc-200 pb-1 whitespace-nowrap shrink-0">
          board →
        </a>
      </header>

      {clips === null && <div className="text-zinc-500 text-center py-10">Loading clips…</div>}
      {clips && clips.length === 0 && <div className="rounded-2xl border border-ink-700 bg-ink-900 p-6 text-center text-zinc-400">No clips served at /api/sounds yet.</div>}

      <div className="flex flex-col gap-3">
        {clips?.map((c) => {
          const fb = feedback[c.id];
          const tone = fb?.status === "heard" ? "border-ok bg-ok/20 shadow-[0_0_24px_rgba(47,214,115,0.35)]" : fb?.status === "waiting" ? "border-accent/60 bg-accent/10" : "border-ink-600 bg-ink-800";
          return (
            <button key={c.id} className={`w-full rounded-2xl border-2 px-5 py-5 text-left transition-all active:scale-[0.98] disabled:opacity-40 ${tone}`} onClick={() => play(c)} disabled={!c.available}>
              <div className="flex items-center gap-4">
                <span className="text-5xl leading-none select-none" role="img" aria-label={c.name}>
                  {c.emoji}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-2xl font-black leading-tight">{c.name}</div>
                  <div className="text-sm text-zinc-400 leading-snug">{c.hint}</div>
                </div>
              </div>
              <div className={`mt-3 text-sm font-semibold min-h-[20px] ${fb?.status === "heard" ? "text-ok" : fb?.status === "missed" ? "text-zinc-500" : fb?.status === "waiting" ? "text-accent-soft animate-pulse" : "text-transparent"}`}>{fb?.text ?? "·"}</div>
            </button>
          );
        })}
      </div>

      {clips && clips.length > 0 && (
        <button className={`w-full rounded-2xl border-2 px-5 py-4 flex items-center justify-center gap-3 text-xl font-black ${sequence ? "border-bad/60 bg-bad/15 text-bad" : "border-accent/60 bg-accent/15 text-accent-soft"}`} onClick={sequence ? stopSequence : playSequence}>
          {sequence ? (
            <>
              <Square size={22} /> Stop · {sequence.step}/{sequence.total}
            </>
          ) : (
            <>
              <Shuffle size={22} /> Play random sequence
            </>
          )}
        </button>
      )}

      <footer className="text-center text-xs text-zinc-500 pt-2 pb-6">
        Open this page on your phone; the laptop is listening.
        {mock && <div className="mt-1 text-fuchsia-300/80">Mock mode — clips are not served and nothing is listening.</div>}
      </footer>
    </div>
  );
}
