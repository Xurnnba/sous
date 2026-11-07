import { Flame, Mic, MicOff, Music, Pause, Play, RotateCcw, Settings, Square, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AudioStreamState } from "../hooks/useAudioStream";
import { useDemo } from "../hooks/useDemo";
import { useSous } from "../hooks/useSous";
import type { VoiceState } from "../hooks/useVoice";
import { MIC_LOCATIONS } from "../lib/device";
import type { ConnectionStatus } from "../types";
import { LevelMeter } from "./Gauges";
import type { View } from "./TopNav";

export function ControlBar({ voice, audio, onChangeView, status }: { voice: VoiceState; audio: AudioStreamState; onChangeView: (v: View) => void; status: ConnectionStatus }) {
  const { state, api } = useSous();
  const demo = useDemo({ api, go: onChangeView, playSoundtrack: audio.playSoundtrack });
  const [busy, setBusy] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const rush = state?.rush ?? false;
  const speed = state?.speed ?? 1;
  const listening = audio.source === "mic";

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
  const providers = state?.providers;

  return (
    <div className="flex items-center gap-2 px-5 py-2 border-b border-ink-700 bg-ink-950/80 shrink-0 flex-nowrap">
      <button className={`btn ${listening ? "btn-on" : ""}`} onClick={() => (listening ? audio.stop() : void audio.startMic())} title={listening ? "Stop streaming this device's microphone" : "Stream this device's microphone to Sous (/ws/audio)"}>
        {listening ? <Mic size={16} /> : <MicOff size={16} />} {listening ? "Listening" : "Listen"}
        <span className="text-[11px] font-normal text-zinc-400 normal-case">· {audio.location}</span>
      </button>
      {listening && (
        <div className="w-20 flex flex-col gap-0.5">
          <LevelMeter level={audio.level} />
          <span className="text-[10px] text-zinc-500 num whitespace-nowrap">
            {audio.framesSent} fr · {audio.wsState}
          </span>
        </div>
      )}
      {audio.error && <span className="text-[11px] text-bad max-w-[200px] truncate" title={audio.error}>{audio.error}</span>}

      <button className={`btn ${rush ? "btn-accent animate-firePulse" : ""}`} onClick={() => run("rush", () => api.control({ rush: !rush }))} disabled={busy === "rush"}>
        <Flame size={16} /> Rush {rush ? "ON" : "off"}
      </button>
      <button className={`btn ${voice.muted ? "btn-danger" : ""}`} onClick={() => voice.setMuted(!voice.muted)}>
        {voice.muted ? <VolumeX size={16} /> : <Volume2 size={16} />} {voice.muted ? "Muted" : "Mute"}
      </button>

      {demo.running && (
        <>
          <span className="pill bg-accent/15 text-accent-soft border border-accent/40 normal-case tracking-normal gap-1.5 whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            Scripted run · {demo.step}/{demo.total} · {demo.label}
          </span>
          <button className="btn btn-danger" onClick={demo.stop}>
            <Square size={14} /> Stop
          </button>
        </>
      )}
      {audio.source === "soundtrack" && (
        <span className="pill bg-ok/15 text-ok border border-ok/40 normal-case tracking-normal gap-1.5 whitespace-nowrap">
          <Music size={12} /> soundtrack {audio.position.toFixed(0)}s / {audio.duration.toFixed(0)}s
        </span>
      )}

      <div className="ml-auto flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
          <span className={`w-2 h-2 rounded-full ${dot}`} /> {dotLabel}
        </span>

        <div className="relative" ref={moreRef}>
          <button className={`btn ${more ? "bg-ink-700" : ""}`} onClick={() => setMore((m) => !m)} aria-expanded={more} title="More controls">
            <Settings size={16} /> More
          </button>
          {more && (
            <div className="absolute right-0 top-full mt-2 z-30 w-80 panel p-3 flex flex-col gap-2 shadow-2xl shadow-black/60">
              <div className="panel-title mb-1">More controls</div>

              <button className={`btn justify-start ${audio.source === "soundtrack" ? "btn-on" : ""}`} onClick={() => (audio.source === "soundtrack" ? audio.stop() : void audio.playSoundtrack())}>
                {audio.source === "soundtrack" ? <Pause size={16} /> : <Music size={16} />} {audio.source === "soundtrack" ? "Stop soundtrack" : "Play soundtrack"}
              </button>

              <label className="btn cursor-pointer gap-2 justify-start">
                <Mic size={16} />
                <span className="text-xs text-zinc-400">This device is at</span>
                <select className="bg-transparent outline-none text-sm flex-1" value={audio.location} onChange={(e) => audio.setLocation(e.target.value as (typeof MIC_LOCATIONS)[number])}>
                  {MIC_LOCATIONS.map((l) => (
                    <option key={l} value={l} className="bg-ink-800">
                      {l}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-zinc-400 pl-1">Sim speed</span>
                <div className="inline-flex rounded-lg border border-ink-600 overflow-hidden">
                  {[1, 2, 4].map((s) => (
                    <button key={s} className={`px-3 py-1.5 text-sm font-semibold ${speed === s ? "bg-accent/20 text-accent-soft" : "bg-ink-800 text-zinc-400 hover:text-zinc-100"}`} onClick={() => void run("speed", () => api.control({ speed: s }))}>
                      {s}x
                    </button>
                  ))}
                </div>
              </div>

              <button className="btn justify-start" onClick={() => { setMore(false); void run("reset", () => api.reset()); }} disabled={busy === "reset"}>
                <RotateCcw size={16} /> Reset simulation
              </button>

              {demo.running ? (
                <button className="btn btn-danger justify-start" onClick={() => { setMore(false); demo.stop(); }}>
                  <Square size={16} /> Stop scripted run
                </button>
              ) : (
                <button className="btn btn-accent justify-start" onClick={() => { setMore(false); demo.start(); }} title="140 s autopilot: rush, soundtrack, storefront, nose scenarios, kitchen">
                  <Play size={16} /> Scripted run
                </button>
              )}
              {demo.complete && <span className="text-[11px] text-ok pl-1">Scripted run complete</span>}

              {providers && (
                <div className="flex flex-wrap gap-1.5 pt-2 border-t border-ink-700">
                  <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">LLM · {providers.llm}</span>
                  <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">TTS · {providers.tts}</span>
                  <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">Ears · {providers.ears}</span>
                  <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">Nose · {providers.nose}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
