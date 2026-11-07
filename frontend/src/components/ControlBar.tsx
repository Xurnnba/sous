import { Flame, Mic, MicOff, Music, Pause, Play, RotateCcw, Square, Volume2, VolumeX, Wind } from "lucide-react";
import { useState } from "react";
import type { AudioStreamState } from "../hooks/useAudioStream";
import { useDemo } from "../hooks/useDemo";
import type { View } from "./TopNav";
import { useSous } from "../hooks/useSous";
import type { VoiceState } from "../hooks/useVoice";
import { scenarioLabels } from "../lib/format";
import type { SmellScenario } from "../types";
import { LevelMeter } from "./Gauges";

export function ControlBar({ voice, audio, onChangeView }: { voice: VoiceState; audio: AudioStreamState; view: View; onChangeView: (v: View) => void }) {
  const { state, api } = useSous();
  const demo = useDemo({ api, go: onChangeView, playSoundtrack: audio.playSoundtrack });
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const rush = state?.rush ?? false;

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

  return (
    <div className="flex items-center gap-2 px-5 py-2 border-b border-ink-700 bg-ink-950/80 shrink-0 flex-wrap">
      <button className={`btn ${rush ? "btn-accent animate-firePulse" : ""}`} onClick={() => run("rush", () => api.control({ rush: !rush }))} disabled={busy === "rush"}>
        <Flame size={16} /> Rush {rush ? "ON" : "off"}
      </button>

      <span className="w-px h-6 bg-ink-700 mx-1" />

      <button className={`btn ${audio.source === "mic" ? "btn-on" : ""}`} onClick={() => (audio.source === "mic" ? audio.stop() : void audio.startMic())}>
        {audio.source === "mic" ? <Mic size={16} /> : <MicOff size={16} />} Mic {audio.source === "mic" ? "on" : "off"}
      </button>
      <button className={`btn ${audio.source === "soundtrack" ? "btn-on" : ""}`} onClick={() => (audio.source === "soundtrack" ? audio.stop() : void audio.playSoundtrack())}>
        {audio.source === "soundtrack" ? <Pause size={16} /> : <Music size={16} />} {audio.source === "soundtrack" ? "Stop soundtrack" : "Play soundtrack"}
      </button>
      {audio.source && (
        <div className="w-24 flex flex-col gap-0.5">
          <LevelMeter level={audio.level} />
          <span className="text-[10px] text-zinc-500 num">{audio.framesSent} frames · {audio.wsState}</span>
        </div>
      )}

      <span className="w-px h-6 bg-ink-700 mx-1" />

      <label className="btn cursor-pointer gap-2">
        <Wind size={16} />
        <select
          className="bg-transparent outline-none text-sm"
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

      <span className="w-px h-6 bg-ink-700 mx-1" />

      <button className={`btn ${voice.muted ? "btn-danger" : ""}`} onClick={() => voice.setMuted(!voice.muted)}>
        {voice.muted ? <VolumeX size={16} /> : <Volume2 size={16} />} {voice.muted ? "Muted" : "Mute"}
      </button>
      <button className="btn" onClick={() => run("reset", () => api.reset())} disabled={busy === "reset"}>
        <RotateCcw size={16} /> Reset
      </button>

      <span className="w-px h-6 bg-ink-700 mx-1" />

      {demo.running ? (
        <>
          <span className="pill bg-accent/15 text-accent-soft border border-accent/40 normal-case tracking-normal gap-1.5">
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
          {demo.complete && <span className="pill bg-ok/15 text-ok border border-ok/40 normal-case tracking-normal">Demo complete</span>}
        </>
      )}

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

      <div className="ml-auto flex items-center gap-2">
        {state && (
          <>
            <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">LLM · {state.providers.llm}</span>
            <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">TTS · {state.providers.tts}</span>
            <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">Nose · {state.senses.smell.device}</span>
          </>
        )}
      </div>
    </div>
  );
}
