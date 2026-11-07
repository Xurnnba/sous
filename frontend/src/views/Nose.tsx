import { AlertTriangle, ArrowRight, Cpu } from "lucide-react";
import { useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Empty, Panel, Ring, Stat, UrgencyPill } from "../components/common";
import { useSous } from "../hooks/useSous";
import { clockTime, HEATER_STEPS_C, pct, scenarioLabels, smellKindLabel, titleCase } from "../lib/format";
import type { Smell } from "../types";

type Stage = { id: string; title: string; sub: string; live: (s: Smell) => boolean; note?: (s: Smell) => string | null };

const STAGES: Stage[] = [
  { id: "sensor", title: "BME688 sensor", sub: "4-step heater sweep", live: (s) => s.device === "serial" || s.device === "http", note: (s) => (s.device === "replay" ? "replayed" : s.device === "none" ? "none" : s.sensor_id) },
  { id: "esp32", title: "ESP32", sub: "1 Hz JSON over Wi-Fi", live: (s) => s.device === "serial" || s.device === "http" },
  { id: "ingest", title: "POST /api/sensor/reading", sub: "same path for board & replay", live: (s) => s.device !== "none" },
  { id: "cal", title: "Calibration", sub: "baseline · RH slope", live: (s) => s.calibration.quality > 0, note: (s) => `${pct(s.calibration.quality)} · ${s.calibration.status}` },
  { id: "fp", title: "Fingerprint", sub: "log-ratios per step", live: (s) => !!s.ratios, note: (s) => (s.ratios ? s.ratios.map((r) => r.toFixed(2)).join(" / ") : null) },
  { id: "clf", title: "GBDT classifier", sub: "6 classes", live: (s) => !!s.probs, note: (s) => (s.probs ? `${winnerOf(s.probs)} ${pct(Math.max(...Object.values(s.probs)))}` : null) },
  { id: "urg", title: "Urgency", sub: "now / next / today / info", live: (s) => s.status === "anomaly", note: (s) => s.anomaly?.urgency ?? null },
  { id: "item", title: "Item", sub: "on the Board", live: (s) => s.status === "anomaly" },
];

const winnerOf = (probs: Record<string, number>): string => Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";

/** Where to start the anomaly shading: from `since` when it is a parseable timestamp, else walk back along the trace while it deviates from baseline. */
function anomalyStartT(trace: Smell["trace"], since: string): number {
  const last = trace[trace.length - 1];
  const sinceMs = new Date(since).getTime();
  if (Number.isFinite(sinceMs)) {
    const ageS = Math.max(0, (Date.now() - sinceMs) / 1000);
    return Math.max(trace[0].t, last.t - ageS);
  }
  let i = trace.length - 1;
  while (i > 0) {
    const p = trace[i];
    const dev = Math.max(...(p.ratios ?? [p.ratio]).map((r) => Math.abs(Math.log(Math.max(0.05, r)))));
    if (dev < 0.08) break;
    i -= 1;
  }
  return trace[i].t;
}

function Fingerprint({ ratios }: { ratios: number[] | null }) {
  if (!ratios) return <Empty>No sweep yet.</Empty>;
  const logs = ratios.map((r) => Math.log(Math.max(0.05, r)));
  const span = Math.max(0.45, ...logs.map((l) => Math.abs(l))) * 1.15; // symmetric scale in log space
  return (
    <div className="relative h-52 grid grid-cols-4 gap-3 pl-14 pr-2">
      <div className="absolute left-0 right-0 top-1/2 border-t border-dashed border-zinc-500/70 pointer-events-none" />
      <span className="absolute left-0 top-1/2 -translate-y-1/2 text-[10px] text-zinc-400 num bg-ink-900 pr-1 pointer-events-none">1.0 base</span>
      {ratios.map((r, i) => {
        const l = logs[i];
        const h = Math.min(50, (Math.abs(l) / span) * 50);
        const up = l >= 0;
        return (
          <div key={i} className="relative flex flex-col items-center justify-end h-full">
            <div className="absolute left-0 right-0" style={{ top: up ? `${50 - h}%` : "50%", height: `${Math.max(0.6, h)}%` }}>
              <div className={`mx-auto w-3/5 h-full rounded-md transition-all duration-500 ${up ? "bg-accent" : "bg-sky-400"}`} />
            </div>
            <div className={`absolute left-0 right-0 text-center num text-sm font-bold ${up ? "text-accent-soft" : "text-sky-300"}`} style={up ? { bottom: `${50 + h + 2}%` } : { top: `${50 + h + 2}%` }}>
              {r.toFixed(2)}
            </div>
            <div className="absolute -bottom-1 left-0 right-0 text-center text-[11px] text-zinc-400 num">
              {HEATER_STEPS_C[i]} °C
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Nose() {
  const { state, api } = useSous();
  const [busy, setBusy] = useState<string | null>(null);
  if (!state) return <Empty>Loading sensor status…</Empty>;
  const smell = state.senses.smell;
  const probs = smell.probs;
  const winner = probs ? winnerOf(probs) : null;
  const trace = smell.trace;
  const anomalyStart = smell.anomaly && trace.length ? anomalyStartT(trace, smell.anomaly.since) : undefined;
  const cal = smell.calibration;
  const warmup = cal.warmup && typeof cal.warmup === "object" ? (cal.warmup as { have?: number; need?: number }) : null;
  // Not "ready" means the baseline is being (re)built — warming at boot, or a rebase after the sensor moved.
  const calibrating = smell.device !== "none" && smell.status !== "offline" && cal.status !== "ready";
  const anomalyLabel = smell.anomaly ? smellKindLabel[smell.anomaly.kind] ?? titleCase(smell.anomaly.kind) : null;
  const statusWord = smell.status === "anomaly" && anomalyLabel ? anomalyLabel : calibrating ? "Calibrating" : titleCase(smell.status);
  const statusTone = smell.status === "anomaly" ? (smell.anomaly?.urgency === "now" ? "text-bad" : "text-warn") : calibrating ? "text-warn" : smell.status === "nominal" ? "text-ok" : smell.status === "offline" ? "text-zinc-500" : "text-warn";
  const calColor = cal.quality > 0.8 ? "#2fd673" : cal.quality > 0.5 ? "#ffb020" : "#ff4d4d";
  const yDomain: [number, number] = [Math.min(0.7, ...trace.map((p) => p.ratio)) - 0.05, Math.max(1.5, ...trace.map((p) => p.ratio)) + 0.1];

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
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-[1400px] mx-auto flex flex-col gap-4">
        {/* HERO */}
        <header className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-baseline gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Nose · VOC heater-sweep fingerprint</div>
              <h1 className={`text-4xl font-black leading-tight ${statusTone}`}>{statusWord}</h1>
            </div>
            <div className="text-lg text-zinc-300">
              at <span className="font-bold capitalize text-zinc-100">{smell.location}</span>
              {smell.anomaly && <span className="text-sm text-zinc-500 ml-2">since {clockTime(smell.anomaly.since)}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`pill border ${smell.device === "replay" ? "bg-warn/15 text-warn border-warn/40" : smell.device === "none" ? "bg-ink-800 text-zinc-400 border-ink-600" : "bg-ok/15 text-ok border-ok/40"}`}>device · {smell.device}</span>
            <span className="pill bg-ink-800 text-zinc-300 border border-ink-600 normal-case tracking-normal">
              {smell.model.name} · {smell.model.features} features · acc {smell.model.accuracy.toFixed(2)}
            </span>
            <span className="pill bg-ink-800 text-zinc-300 border border-ink-600 num">{smell.sensor_id}</span>
          </div>
        </header>

        {smell.device === "replay" && (
          <div className="rounded-xl border border-warn/40 bg-warn/10 text-warn px-4 py-3 flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <p className="text-sm">
              <strong>No sensor board connected</strong> — replaying synthetic sensor data through the hardware endpoint. Firmware in <code className="num">/firmware</code>.
            </p>
          </div>
        )}
        {smell.device === "none" && (
          <div className="rounded-xl border border-ink-600 bg-ink-800 text-zinc-300 px-4 py-3 flex items-start gap-3">
            <Cpu size={18} className="mt-0.5 shrink-0" />
            <p className="text-sm">No nose input. Plug in the ESP32 or start a scenario below.</p>
          </div>
        )}

        {/* MAIN GRID */}
        <div className="grid grid-cols-3 gap-4">
          <Panel title="Fingerprint" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">baseline / gas · per heater step</span>}>
            <Fingerprint ratios={smell.ratios} />
            <div className="flex justify-between text-[11px] text-zinc-500 mt-4">
              <span>
                <span className="inline-block w-2 h-2 rounded-sm bg-accent mr-1" />
                above 1 · reducing gas (VOCs)
              </span>
              <span>
                <span className="inline-block w-2 h-2 rounded-sm bg-sky-400 mr-1" />
                below 1 · oxidising
              </span>
            </div>
            {smell.single_channel && <p className="text-[11px] text-warn mt-2">Single-channel sensor — all four steps identical, shape features unavailable.</p>}
          </Panel>

          <Panel
            title="What the nose thinks"
            right={
              smell.status === "anomaly" && anomalyLabel ? (
                <span className="flex items-center gap-1.5">
                  <span className={`pill ${smell.anomaly?.urgency === "now" ? "bg-bad/15 text-bad" : "bg-warn/15 text-warn"} normal-case tracking-normal`}>{anomalyLabel}</span>
                  {smell.anomaly && <UrgencyPill urgency={smell.anomaly.urgency} />}
                </span>
              ) : calibrating ? (
                <span className="pill bg-warn/15 text-warn">calibrating</span>
              ) : (
                <span className={`pill ${smell.status === "nominal" ? "bg-ok/15 text-ok" : "bg-ink-700 text-zinc-300"}`}>{smell.status}</span>
              )
            }
          >
            {calibrating && (
              <p className="text-[11px] text-warn mb-2 -mt-1">
                re-calibrating at {smell.location}
                {warmup && typeof warmup.have === "number" && typeof warmup.need === "number" ? ` · ${warmup.have}/${warmup.need} samples` : cal.samples ? ` · ${cal.samples} samples` : ""}
              </p>
            )}
            {!probs ? (
              <Empty>No classification yet.</Empty>
            ) : (
              <div className={`flex flex-col gap-2 transition-opacity ${calibrating ? "opacity-40 grayscale" : ""}`} aria-disabled={calibrating}>
                {Object.entries(probs)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => {
                    const win = k === winner;
                    return (
                      <div key={k} className="flex items-center gap-3">
                        <span className={`w-40 truncate text-sm ${win ? "font-black text-zinc-50" : "text-zinc-400"}`}>{smellKindLabel[k] ?? titleCase(k)}</span>
                        <div className="flex-1 h-3 rounded-full bg-ink-700 overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-500 ${win ? (k === "nominal" ? "bg-ok" : "bg-accent") : "bg-zinc-500"}`} style={{ width: `${Math.max(1, v * 100)}%` }} />
                        </div>
                        <span className={`num w-12 text-right text-sm ${win ? "font-black" : "text-zinc-500"}`}>{pct(v)}</span>
                      </div>
                    );
                  })}
                <div className="mt-3 flex items-end justify-between">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500">Confidence</div>
                    <div className="num text-3xl font-black">{pct(smell.anomaly?.confidence ?? (probs[winner ?? ""] ?? 0))}</div>
                  </div>
                  {smell.anomaly && (
                    <div className="text-right">
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500">Urgency</div>
                      <UrgencyPill urgency={smell.anomaly.urgency} className="text-sm px-3 py-1" />
                    </div>
                  )}
                </div>
              </div>
            )}
          </Panel>

          <Panel title="Calibration" right={<span className="pill bg-ink-800 text-zinc-300 border border-ink-600">{cal.status}</span>}>
            <div className="flex items-center gap-4">
              <Ring value={cal.quality} size={88} stroke={9} color={calColor}>
                <div className="text-center">
                  <div className="num text-xl font-black leading-none">{Math.round(cal.quality * 100)}</div>
                  <div className="text-[9px] uppercase tracking-widest text-zinc-500">quality</div>
                </div>
              </Ring>
              <div className="grid grid-cols-2 gap-2 flex-1">
                <Stat label="RH slope" value={cal.rh_slope === null ? "—" : cal.rh_slope.toFixed(3)} sub="per %RH" />
                <Stat label="Samples" value={cal.samples} sub="baseline windows" />
              </div>
            </div>
            <div className="mt-4">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1.5">Baseline per step (clean air)</div>
              {cal.baseline_ohm ? (
                <div className="grid grid-cols-4 gap-2">
                  {cal.baseline_ohm.map((b, i) => (
                    <div key={i} className="rounded-lg bg-ink-800 py-2 text-center">
                      <div className="text-[10px] text-zinc-500 num">{HEATER_STEPS_C[i] ?? `step ${i + 1}`} °C</div>
                      <div className="num text-base font-bold">{(b / 1000).toFixed(0)} kΩ</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-zinc-500">No baseline yet — the first clean-air minute sets it.</div>
              )}
            </div>
            <div className="text-[11px] text-zinc-500 num mt-3">
              {typeof smell.temp_c === "number" && `${smell.temp_c.toFixed(1)} °C`}
              {typeof smell.rh === "number" && ` · ${Math.round(smell.rh)} %RH`}
            </div>
          </Panel>
        </div>

        <div className="grid grid-cols-[1.6fr_1fr] gap-4">
          <Panel title="Trace · mean ratio" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">last 180 s · anomaly shaded</span>}>
            {trace.length < 2 ? (
              <Empty>No sensor samples yet. The trace fills at 1 Hz once a board or the replay is posting readings.</Empty>
            ) : (
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={trace} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="ratioFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#ff7a1a" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#ff7a1a" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#26262c" vertical={false} />
                    <XAxis dataKey="t" tick={{ fill: "#a1a1aa", fontSize: 11 }} stroke="#36363e" tickFormatter={(t: number) => `${Math.round(t)}s`} />
                    <YAxis domain={yDomain} tick={{ fill: "#a1a1aa", fontSize: 11 }} stroke="#36363e" width={36} tickFormatter={(v: number) => v.toFixed(1)} />
                    <Tooltip contentStyle={{ background: "#1a1a1e", border: "1px solid #36363e", borderRadius: 8, fontSize: 12 }} labelFormatter={(t) => `t = ${Number(t).toFixed(0)}s`} formatter={(v: number) => [v.toFixed(3), "ratio"]} />
                    <ReferenceLine y={1} stroke="#71717a" strokeDasharray="4 4" />
                    {smell.status === "anomaly" && anomalyStart !== undefined && <ReferenceArea x1={anomalyStart} x2={trace[trace.length - 1].t} fill="#ff4d4d" fillOpacity={0.12} strokeOpacity={0} />}
                    <Area type="monotone" dataKey="ratio" stroke="none" fill="url(#ratioFill)" isAnimationActive={false} tooltipType="none" />
                    <Line type="monotone" dataKey="ratio" stroke="#ff7a1a" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </Panel>

          <Panel title="Simulator (no board today)" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">POST /api/smell/scenario</span>}>
            <div className="grid grid-cols-2 gap-2">
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
            <p className="text-xs text-zinc-500 mt-3">Each scenario replays heater sweeps through the hardware ingest path, so calibration, classifier, urgency and the Board are exercised exactly as with a real board.</p>
          </Panel>
        </div>

        {/* PIPELINE */}
        <Panel title="Pipeline">
          <ol className="flex items-stretch gap-1.5 overflow-x-auto pb-1">
            {STAGES.map((st, i) => {
              const live = st.live(smell);
              const replayHere = smell.device === "replay" && st.id === "ingest";
              const note = st.note?.(smell) ?? null;
              return (
                <li key={st.id} className="flex items-center gap-1.5 min-w-0 flex-1">
                  <div className={`flex-1 min-w-0 rounded-lg border px-3 py-2 transition-colors ${live ? "border-ok/50 bg-ok/5" : replayHere ? "border-warn/50 bg-warn/5" : "border-ink-700 bg-ink-800/60"}`}>
                    <div className="flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${live ? "bg-ok shadow-[0_0_8px_#2fd673]" : replayHere ? "bg-warn shadow-[0_0_8px_#ffb020]" : "bg-ink-600"}`} />
                      <span className="text-xs font-bold truncate">{st.title}</span>
                    </div>
                    <div className="text-[10px] text-zinc-500 truncate">{note ?? st.sub}</div>
                  </div>
                  {i < STAGES.length - 1 && <ArrowRight size={14} className="text-zinc-600 shrink-0" />}
                </li>
              );
            })}
          </ol>
        </Panel>
      </div>
    </div>
  );
}
