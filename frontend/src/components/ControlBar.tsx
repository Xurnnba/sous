import { Flame, Mic, MicOff, Music, Pause, Play, RotateCcw, Settings, Square, Volume2, VolumeX, Wind } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AudioStreamState } from "../hooks/useAudioStream";
import { useDemo } from "../hooks/useDemo";
import { useSous } from "../hooks/useSous";
import type { VoiceState } from "../hooks/useVoice";
import { scenarioLabels } from "../lib/format";
import type { ConnectionStatus, SmellScenario } from "../types";
import { LevelMeter } from "./Gauges";
import type { View } from "./TopNav";

export function ControlBar({ voice, audio, onChangeView, status }: { voice: VoiceState; audio: AudioStreamState; onChangeView: (v: View) => void; status: ConnectionStatus }) {
  const { state, api } = useSous();
  const demo = useDemo({ api, go: onChangeView, playSoundtrack: audio.playSoundtrack });
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const rush = state?.rush ?? false;

  useEffect(() => {
    if (!more) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMore(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMore(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [more]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      console.warn(key, err);
    } finally {
      setBusy(null);
    }
  };

  const dot = status === "open" || status === "mock" ? "bg-ok" : status === "connecting" ? "bg-warn animate-pulse" : "bg-bad";
  const dotLabel = status === "mock" ? "mock" : status === "open" ? "live" : status === "connecting" ? "connecting" : "reconnecting";

  return (
    <div className="flex items-center gap-2 px-5 py-2 border-b border-ink-700 bg-ink-950/80 shrink-0 flex-nowrap">
      {demo.running ? (
        <>
          <span className="pill bg-accent/15 text-accent-soft border border-accent/40 normal-case tracking-normal gap-1.5 whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            Demo · step {demo.step}/{demo.total} · {demo.label}
          </span>
          <button className="btn btn-danger" onClick={demo.stop} title="Stop the demo and return the nose to nominal">
            <Square size={14} /> Stop
          </button>
        </>
      ) : (
        <>
          <button className="btn btn-accent" onClick={demo.start} title="Scripted 140 s walkthrough: rush, ears, storefront, nose scenarios, back office">
            <Play size={16} /> Run demo
          </button>
          {demo.complete && <span className="pill bg-ok/15 text-ok border border-ok/40 normal-case tracking-normal whitespace-nowrap">Demo complete</span>}
        </>
      )}

      <span className="w-px h-6 bg-ink-700 mx-1" />

      <button className={`btn ${rush ? "btn-accent animate-firePulse" : ""}`} onClick={() => run("rush", () => api.control({ rush: !rush }))} disabled={busy === "rush"}>
        <Flame size={16} /> Rush {rush ? "ON" : "off"}
      </button>
      <button className={`btn ${audio.source === "soundtrack" ? "btn-on" : ""}`} onClick={() => (audio.source === "soundtrack" ? audio.stop() : void audio.playSoundtrack())}>
        {audio.source === "soundtrack" ? <Pause size={16} /> : <Music size={16} />} {audio.source === "soundtrack" ? "Stop soundtrack" : "Play soundtrack"}
      </button>
      {audio.source && (
        <div className="w-24 flex flex-col gap-0.5">
          <LevelMeter level={audio.level} />
          <span className="text-[10px] text-zinc-500 num whitespace-nowrap">
            {audio.source === "mic" ? "mic · " : ""}
            {audio.framesSent} frames · {audio.wsState}
          </span>
        </div>
      )}
      <button className={`btn ${voice.muted ? "btn-danger" : ""}`} onClick={() => voice.setMuted(!voice.muted)}>
        {voice.muted ? <VolumeX size={16} /> : <Volume2 size={16} />} {voice.muted ? "Muted" : "Mute"}
      </button>

      <div className="ml-auto flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
          <span className={`w-2 h-2 rounded-full ${dot}`} /> {dotLabel}
        </span>

        <div className="relative" ref={moreRef}>
          <button className={`btn ${more ? "bg-ink-700" : ""}`} onClick={() => setMore((m) => !m)} aria-expanded={more} title="More controls">
            <Settings size={16} /> More
          </button>
          {more && (
            <div className="absolute right-0 top-full mt-2 z-30 w-72 panel p-3 flex flex-col gap-2 shadow-2xl shadow-black/60">
              <div className="panel-title mb-1">More controls</div>

              <button className={`btn justify-start ${audio.source === "mic" ? "btn-on" : ""}`} onClick={() => (audio.source === "mic" ? audio.stop() : void audio.startMic())}>
                {audio.source === "mic" ? <Mic size={16} /> : <MicOff size={16} />} Mic {audio.source === "mic" ? "on" : "off"}
              </button>

              <label className="btn cursor-pointer gap-2 justify-start">
                <Wind size={16} />
                <select
                  className="bg-transparent outline-none text-sm flex-1"
                  value={state?.senses.smell.scenario ?? ""}
                  onChange={(e) => run("scenario", () => api.smellScenario(e.target.value as SmellScenario))}
                >
                  <option value="" disabled>
                    Smell scenario
                  </option>
                  {scenarioLabels.map((s) => (
                    <option key={s.name} value={s.name} className="bg-ink-800">
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-zinc-400 pl-1">Sim speed</span>
                <div className="inline-flex rounded-lg border border-ink-600 overflow-hidden">
                  {[1, 2, 4].map((s) => (
                    <button
                      key={s}
                      className={`px-3 py-1.5 text-sm font-semibold ${speed === s ? "bg-accent/20 text-accent-soft" : "bg-ink-800 text-zinc-400 hover:text-zinc-100"}`}
                      onClick={() => {
                        setSpeed(s);
                        void run("speed", () => api.control({ speed: s }));
                      }}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </div>

              <button
                className="btn justify-start"
                onClick={() => {
                  setMore(false);
                  void run("reset", () => api.reset());
                }}
                disabled={busy === "reset"}
              >
                <RotateCcw size={16} /> Reset simulation
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
