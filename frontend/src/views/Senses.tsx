import { AlertTriangle, Bell, Cpu, DoorOpen, Printer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SoundtrackTimeline } from "../components/SoundtrackTimeline";
import { EventFeed } from "../components/EventFeed";
import { LevelMeter } from "../components/Gauges";
import { Empty, Panel } from "../components/common";
import type { AudioStreamState } from "../hooks/useAudioStream";
import { useSous } from "../hooks/useSous";
import { scenarioLabels } from "../lib/format";
import type { HearingInjectKind, SmellDevice } from "../types";

type Stage = { id: string; title: string; sub: string; liveWhen: (d: SmellDevice, status: string) => boolean };

const STAGES: Stage[] = [
  { id: "sensor", title: "BME688 / MQ-135", sub: "VOC gas resistance, temp, RH", liveWhen: (d) => d === "serial" || d === "http" },
  { id: "fw", title: "ESP32 firmware", sub: "1 Hz JSON over Wi-Fi", liveWhen: (d) => d === "serial" || d === "http" },
  { id: "ingest", title: "POST /api/sensor/reading", sub: "same path for hardware and replay", liveWhen: (d) => d !== "none" },
  { id: "dsp", title: "Baseline · RH comp · ratio · d/dt", sub: "rolling baseline, humidity compensation", liveWhen: (d) => d !== "none" },
  { id: "detect", title: "Anomaly detector", sub: "spoilage / burning / oil / cleaning", liveWhen: (_d, s) => s === "anomaly" },
  { id: "fusion", title: "LLM context fusion", sub: "nose + inventory + orders", liveWhen: (_d, s) => s === "anomaly" },
  { id: "act", title: "Voice & actions", sub: "speak · hide · substitute · reorder", liveWhen: (_d, s) => s === "anomaly" },
];

const injectMeta: { kind: HearingInjectKind; label: string; icon: typeof Bell }[] = [
  { kind: "ticket_burst", label: "Ticket burst", icon: Printer },
  { kind: "fryer_alarm", label: "Fryer alarm", icon: Bell },
  { kind: "door_chime", label: "Door chime", icon: DoorOpen },
];

export function Senses({ audio }: { audio: AudioStreamState }) {
  const { state, events, api } = useSous();
  const [busy, setBusy] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);
  // Stamp the start of each playback; keep it after playback ends so the detected markers stay visible until the next play.
  useEffect(() => {
    if (audio.source === "soundtrack") startedAt.current = Date.now();
  }, [audio.source]);
  const playbackFinished = audio.source !== "soundtrack" && startedAt.current !== null;

  if (!state) return <Empty>Loading sensor status…</Empty>;
  const smell = state.senses.smell;
  const hearing = events.filter((e) => e.sense === "hearing");
  const latestFeat = hearing.find((e) => e.data && ("peak_hz" in e.data || "db" in e.data || "rms" in e.data || "flatness" in e.data));

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 grid grid-cols-[1.3fr_1fr] gap-4 content-start">
      <header className="col-span-2 flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Sensor status · providers</div>
          <h1 className="text-2xl font-black">Senses</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">LLM · {state.providers.llm}</span>
          <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">TTS · {state.providers.tts}</span>
          <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">Nose · {smell.device}</span>
        </div>
      </header>
      {/* NOSE */}
      <div className="flex flex-col gap-4">
        {smell.device === "replay" && (
          <div className="rounded-xl border border-warn/40 bg-warn/10 text-warn px-4 py-3 flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <p className="text-sm">
              <strong>No sensor board connected</strong> — replaying a recorded/synthetic trace through the same ingest endpoint the hardware uses (<code className="num">POST /api/sensor/reading</code>).
            </p>
          </div>
        )}
        {smell.device === "none" && (
          <div className="rounded-xl border border-ink-600 bg-ink-800 text-zinc-300 px-4 py-3 flex items-start gap-3">
            <Cpu size={18} className="mt-0.5 shrink-0" />
            <p className="text-sm">No nose input at all. Plug in the ESP32 or start a scenario below to replay a trace.</p>
          </div>
        )}
        {(smell.device === "serial" || smell.device === "http") && (
          <div className="rounded-xl border border-ok/40 bg-ok/10 text-ok px-4 py-3 flex items-start gap-3">
            <Cpu size={18} className="mt-0.5 shrink-0" />
            <p className="text-sm">
              <strong>Hardware live</strong> — {smell.sensor_id} posting over {smell.device} from {smell.location}.
            </p>
          </div>
        )}

        <Panel title="Nose pipeline" right={<span className="pill bg-ink-800 text-zinc-300 border border-ink-600">device · {smell.device}</span>}>
          {smell.device === "replay" && (
            <p className="text-[11px] text-zinc-500 mb-3 -mt-1">
              Firmware for ESP32 + BME688 and Arduino + MQ-135 is in <code className="num">/firmware</code>; a real board posting to this endpoint takes over automatically.
            </p>
          )}
          <ol className="flex flex-col gap-0">
            {STAGES.map((s, i) => {
              const live = s.liveWhen(smell.device, smell.status);
              const replayHere = smell.device === "replay" && s.id === "ingest";
              return (
                <li key={s.id} className="flex items-stretch gap-3">
                  <div className="flex flex-col items-center w-6">
                    <span className={`w-3 h-3 rounded-full mt-4 ${live ? "bg-ok shadow-[0_0_12px_#2fd673]" : replayHere ? "bg-warn shadow-[0_0_12px_#ffb020]" : "bg-ink-600"}`} />
                    {i < STAGES.length - 1 && <span className="flex-1 w-px bg-ink-600 my-1" />}
                  </div>
                  <div className={`flex-1 rounded-xl border px-4 py-3 mb-2 transition-colors ${live ? "border-ok/50 bg-ok/5" : replayHere ? "border-warn/50 bg-warn/5" : "border-ink-700 bg-ink-800/60"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-bold">{s.title}</div>
                      {live && <span className="pill bg-ok/15 text-ok">live</span>}
                      {replayHere && <span className="pill bg-warn/15 text-warn">replay source</span>}
                      {(s.id === "sensor" || s.id === "fw") && smell.device === "replay" && <span className="pill bg-ink-700 text-zinc-400">not connected</span>}
                    </div>
                    <div className="text-xs text-zinc-400 mt-0.5">{s.sub}</div>
                    {s.id === "dsp" && smell.ratio !== null && (
                      <div className="text-xs num text-zinc-300 mt-1">
                        ratio {smell.ratio.toFixed(3)} · gas {smell.gas_ohm ? `${(smell.gas_ohm / 1000).toFixed(1)} kΩ` : "—"} · baseline {smell.baseline_ohm ? `${(smell.baseline_ohm / 1000).toFixed(1)} kΩ` : "—"} · {smell.temp_c?.toFixed(1) ?? "—"} °C · {smell.rh ?? "—"} %RH
                      </div>
                    )}
                    {s.id === "detect" && smell.anomaly && (
                      <div className="text-xs text-bad mt-1">
                        {smell.anomaly.kind} · magnitude {smell.anomaly.magnitude.toFixed(2)}
                      </div>
                    )}
                    {s.id === "fusion" && (
                      <div className="text-xs text-zinc-500 mt-1">provider: {state.providers.llm}</div>
                    )}
                    {s.id === "act" && state.voice.last_line && <div className="text-xs text-zinc-300 mt-1 italic truncate">"{state.voice.last_line}"</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        </Panel>

        <Panel title="Smell scenarios" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">POST /api/smell/scenario</span>}>
          <div className="grid grid-cols-3 gap-2">
            {scenarioLabels.map((s) => {
              const active = smell.scenario === s.name;
              const danger = s.name === "stop";
              return (
                <button key={s.name} className={`btn justify-center py-3 ${active ? "btn-accent" : danger ? "btn-danger" : ""}`} disabled={busy === s.name} onClick={() => run(s.name, () => api.smellScenario(s.name))}>
                  {s.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-zinc-500 mt-3">Each scenario replays a trace through the hardware ingest path, so the detector, fusion and voice stages are exercised exactly as with a real board.</p>
        </Panel>
      </div>

      {/* EARS */}
      <div className="flex flex-col gap-4">
        <Panel
          title="Ears · input"
          right={
            <span className={`pill border ${state.senses.hearing.active ? "bg-ok/15 text-ok border-ok/40" : "bg-ink-800 text-zinc-400 border-ink-600"}`}>
              {state.senses.hearing.active ? `live · ${state.senses.hearing.source}` : "inactive"}
            </span>
          }
        >
          <div className="flex gap-2 mb-3">
            <button className={`btn ${audio.source === "mic" ? "btn-on" : ""}`} onClick={() => (audio.source === "mic" ? audio.stop() : void audio.startMic())}>
              {audio.source === "mic" ? "Stop mic" : "Start mic"}
            </button>
            <button className={`btn ${audio.source === "soundtrack" ? "btn-on" : ""}`} onClick={() => (audio.source === "soundtrack" ? audio.stop() : void audio.playSoundtrack())}>
              {audio.source === "soundtrack" ? "Stop soundtrack" : "Play demo soundtrack"}
            </button>
          </div>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500 w-12">Level</span>
            <LevelMeter level={audio.level} />
            <span className="num text-xs text-zinc-400 w-32 text-right">
              {audio.source ? `${audio.framesSent} × 250 ms` : "no input"}
            </span>
          </div>
          {audio.error && <p className="text-xs text-bad mb-3">{audio.error}</p>}
          <SoundtrackTimeline truth={audio.truth} position={audio.position} duration={audio.duration} detections={hearing} startedAt={startedAt.current} finished={playbackFinished} />
          <p className="text-xs text-zinc-500 mt-3">
            Audio is downsampled in-browser to 16 kHz mono Int16 and streamed as 250 ms binary frames to <code className="num">/ws/audio</code>. Nothing is recorded.
          </p>
        </Panel>

        <Panel title="Classifier features" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">latest hearing event</span>}>
          {!latestFeat ? (
            <Empty>No classifier readouts yet. Features appear here with each hearing event (peak_hz, flatness, level).</Empty>
          ) : (
            <div>
              <div className="text-sm font-semibold mb-2">
                {latestFeat.label} <span className="text-zinc-500 font-normal">· {latestFeat.kind}</span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {(["peak_hz", "flatness", "level"] as const).map((k) => {
                  const v = k === "level" ? latestFeat.data.db ?? latestFeat.data.rms : latestFeat.data[k];
                  return (
                    <div key={k} className="rounded-lg bg-ink-800 py-2 text-center">
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500">{k}</div>
                      <div className="num text-xl font-bold">{typeof v === "number" ? (k === "peak_hz" ? `${Math.round(v)} Hz` : k === "level" ? `${v.toFixed(1)} dBFS` : v.toFixed(2)) : "—"}</div>
                    </div>
                  );
                })}
              </div>
              {Object.keys(latestFeat.data).filter((k) => !["peak_hz", "flatness", "db", "rms"].includes(k)).length > 0 && (
                <div className="text-xs text-zinc-500 mt-2 num truncate">
                  {Object.entries(latestFeat.data)
                    .filter(([k]) => !["peak_hz", "flatness", "db", "rms"].includes(k))
                    .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(2) : String(v)}`)
                    .join(" · ")}
                </div>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Inject (fallback if the room is too loud)" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">POST /api/hearing/inject</span>}>
          <div className="grid grid-cols-3 gap-2">
            {injectMeta.map((m) => {
              const Icon = m.icon;
              return (
                <button key={m.kind} className="btn justify-center py-3" disabled={busy === m.kind} onClick={() => run(m.kind, () => api.hearingInject(m.kind))}>
                  <Icon size={16} /> {m.label}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel title="Hearing events" className="flex-1 min-h-[200px]">
          <EventFeed events={hearing} limit={15} compact />
        </Panel>
      </div>
    </div>
  );
}
