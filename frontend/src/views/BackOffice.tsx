import { ArrowLeftRight, Brain, ClipboardList, EyeOff, Flame, HandHelping, MessageSquare, Percent, RotateCcw, type LucideIcon } from "lucide-react";
import { Area, Bar as RBar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Bar, Empty, Panel } from "../components/common";
import { useSous } from "../hooks/useSous";
import { clockTime, freshnessClass, minutesToStockoutColor, money } from "../lib/format";
import type { ActionType } from "../types";

const actionIcon: Record<ActionType, LucideIcon> = {
  menu_hide: EyeOff,
  menu_restore: RotateCcw,
  menu_discount: Percent,
  substitute: ArrowLeftRight,
  reorder_draft: ClipboardList,
  fire_now: Flame,
  ask_human: HandHelping,
  speak: MessageSquare,
};

const actionTint: Record<ActionType, string> = {
  menu_hide: "text-bad bg-bad/10",
  menu_restore: "text-ok bg-ok/10",
  menu_discount: "text-ok bg-ok/10",
  substitute: "text-accent-soft bg-accent/10",
  reorder_draft: "text-sky-400 bg-sky-400/10",
  fire_now: "text-accent-soft bg-accent/10",
  ask_human: "text-warn bg-warn/10",
  speak: "text-zinc-300 bg-ink-700",
};

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel p-4">
      <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{label}</div>
      <div className="num text-3xl font-black mt-1">{value}</div>
      {sub && <div className="text-xs text-zinc-400 mt-0.5">{sub}</div>}
    </div>
  );
}

export function BackOffice() {
  const { state, actions } = useSous();
  if (!state) return <Empty>Loading the back office…</Empty>;
  const inv = [...state.inventory].sort((a, b) => (a.minutes_to_stockout ?? 1e9) - (b.minutes_to_stockout ?? 1e9));
  const forecast = inv
    .filter((i) => i.minutes_to_stockout !== null)
    .slice(0, 8)
    .map((i) => ({ name: i.label ?? i.name, minutes: Math.min(180, i.minutes_to_stockout ?? 0), raw: i.minutes_to_stockout ?? 0 }));
  const smell = state.senses.smell;
  const trace = smell.trace;
  const anomalyStart = smell.anomaly ? trace.find((p) => p.ratio > 1.3)?.t ?? trace[Math.max(0, trace.length - 20)]?.t : undefined;
  const reorder = actions.find((a) => a.type === "reorder_draft") ?? state.actions.find((a) => a.type === "reorder_draft");
  const log = actions.length ? actions : state.actions;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="grid grid-cols-4 gap-4 mb-4">
        <Tile label="Orders served" value={String(state.metrics.orders_served)} sub="since open" />
        <Tile label="Stockouts prevented" value={String(state.metrics.stockouts_prevented)} sub="items pulled before 86" />
        <Tile label="Refunds avoided" value={money(state.metrics.est_refunds_avoided_usd)} sub="estimated" />
        <Tile label="Waste saved" value={money(state.metrics.est_waste_saved_usd)} sub="estimated" />
      </div>

      <div className="grid grid-cols-[1.4fr_1fr] gap-4 mb-4">
        <Panel title="Inventory" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">recipe-level burn</span>}>
          {inv.length === 0 ? (
            <Empty>No inventory loaded yet.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-widest text-zinc-500">
                <tr className="text-left">
                  <th className="py-1 font-semibold">Ingredient</th>
                  <th className="py-1 font-semibold w-44">On hand / par</th>
                  <th className="py-1 font-semibold text-right">Burn / min</th>
                  <th className="py-1 font-semibold text-right">To stockout</th>
                  <th className="py-1 font-semibold">Freshness</th>
                  <th className="py-1 font-semibold">Where</th>
                </tr>
              </thead>
              <tbody>
                {inv.map((i) => {
                  const pct = i.par ? i.on_hand / i.par : 0;
                  return (
                    <tr key={i.name} className="border-t border-ink-700/70">
                      <td className="py-2 font-semibold capitalize">{i.label ?? i.name}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <Bar value={i.on_hand} max={i.par} className="flex-1" color={pct < 0.2 ? "bg-bad" : pct < 0.45 ? "bg-warn" : "bg-ok"} />
                          <span className="num text-xs text-zinc-300 w-20 text-right">
                            {Math.round(i.on_hand)}/{i.par} {i.unit}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 text-right num text-zinc-300">{i.burn_rate_per_min.toFixed(2)}</td>
                      <td className={`py-2 text-right num font-bold ${minutesToStockoutColor(i.minutes_to_stockout)}`}>{i.minutes_to_stockout === null ? "—" : `${i.minutes_to_stockout} min`}</td>
                      <td className="py-2">
                        <span className={`pill border ${freshnessClass[i.freshness]}`}>{i.freshness}</span>
                        <span className="text-[10px] text-zinc-500 ml-1.5">{i.days_in_stock}d</span>
                      </td>
                      <td className="py-2 text-zinc-400">{i.location}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Stockout forecast" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">minutes at current burn</span>}>
          {forecast.length === 0 ? (
            <Empty>No burn data yet.</Empty>
          ) : (
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={forecast} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                  <CartesianGrid horizontal={false} stroke="#26262c" />
                  <XAxis type="number" domain={[0, 180]} tick={{ fill: "#a1a1aa", fontSize: 11 }} stroke="#36363e" />
                  <YAxis type="category" dataKey="name" width={90} tick={{ fill: "#e4e4e7", fontSize: 12 }} stroke="#36363e" />
                  <Tooltip cursor={{ fill: "#1a1a1e" }} contentStyle={{ background: "#1a1a1e", border: "1px solid #36363e", borderRadius: 8, fontSize: 12 }} formatter={(_v, _n, p) => [`${(p.payload as { raw: number }).raw} min`, "to stockout"]} />
                  <RBar dataKey="minutes" radius={[0, 6, 6, 0]} isAnimationActive={false}>
                    {forecast.map((f) => (
                      <Cell key={f.name} fill={f.raw <= 10 ? "#ff4d4d" : f.raw <= 30 ? "#ffb020" : "#2fd673"} />
                    ))}
                  </RBar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-[1.4fr_1fr] gap-4 mb-4">
        <Panel
          title="Nose · VOC ratio"
          right={
            <div className="flex items-center gap-2">
              <span className={`pill border ${smell.status === "anomaly" ? "bg-bad/15 text-bad border-bad/40" : smell.status === "nominal" ? "bg-ok/15 text-ok border-ok/40" : "bg-ink-800 text-zinc-300 border-ink-600"}`}>{smell.status}</span>
              <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">device · {smell.device}</span>
            </div>
          }
        >
          {trace.length === 0 ? (
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
                  <XAxis dataKey="t" tick={{ fill: "#a1a1aa", fontSize: 11 }} stroke="#36363e" tickFormatter={(t: number) => `${t}s`} />
                  <YAxis domain={[0.8, (d: number) => Math.max(1.6, Math.ceil(d * 10) / 10)]} tick={{ fill: "#a1a1aa", fontSize: 11 }} stroke="#36363e" width={36} />
                  <Tooltip contentStyle={{ background: "#1a1a1e", border: "1px solid #36363e", borderRadius: 8, fontSize: 12 }} labelFormatter={(t) => `t = ${t}s`} formatter={(v: number) => [v.toFixed(3), "ratio"]} />
                  {smell.status === "anomaly" && anomalyStart !== undefined && <ReferenceArea x1={anomalyStart} x2={trace[trace.length - 1].t} fill="#ff4d4d" fillOpacity={0.12} strokeOpacity={0} />}
                  <Area type="monotone" dataKey="ratio" stroke="none" fill="url(#ratioFill)" isAnimationActive={false} />
                  <Line type="monotone" dataKey="ratio" stroke="#ff7a1a" strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="grid grid-cols-5 gap-3 mt-3 text-center">
            {[
              ["gas", smell.gas_ohm === null ? "—" : `${(smell.gas_ohm / 1000).toFixed(1)} kΩ`],
              ["baseline", smell.baseline_ohm === null ? "—" : `${(smell.baseline_ohm / 1000).toFixed(1)} kΩ`],
              ["ratio", smell.ratio === null ? "—" : smell.ratio.toFixed(2)],
              ["temp", smell.temp_c === null ? "—" : `${smell.temp_c.toFixed(1)} °C`],
              ["rh", smell.rh === null ? "—" : `${Math.round(smell.rh)} %`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-ink-800 py-2">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">{k}</div>
                <div className="num text-lg font-bold">{v}</div>
              </div>
            ))}
          </div>
          <div className="text-xs text-zinc-400 mt-2">
            {smell.sensor_id} @ {smell.location}
            {smell.anomaly && (
              <span className="text-bad ml-2">
                · {smell.anomaly.kind} ×{smell.anomaly.magnitude.toFixed(2)} since {clockTime(smell.anomaly.since)}
              </span>
            )}
            {smell.scenario && <span className="ml-2 text-zinc-500">· scenario: {smell.scenario}</span>}
          </div>
        </Panel>

        <Panel title="Reorder draft" right={<ClipboardList size={16} className="text-sky-400" />}>
          {!reorder ? (
            <Empty>No reorder drafted yet. Sous drafts one when an ingredient is forecast to run out.</Empty>
          ) : (
            <div className="text-sm space-y-3">
              <p className="font-semibold">{reorder.summary}</p>
              <ReorderPayload payload={reorder.payload} />
              <div className="text-xs text-zinc-500">
                drafted {clockTime(reorder.t)} by {reorder.by} · awaiting manager approval
              </div>
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Actions log" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">{log.length} actions</span>}>
        {log.length === 0 ? (
          <Empty>Sous hasn't acted yet. Actions appear here when it hides a menu item, fires a ticket, or drafts a reorder.</Empty>
        ) : (
          <ul className="divide-y divide-ink-700/70">
            {log.slice(0, 30).map((a) => {
              const Icon = actionIcon[a.type] ?? Brain;
              return (
                <li key={a.id} className="flex items-center gap-3 py-2 animate-slideIn">
                  <span className={`inline-flex p-1.5 rounded-md ${actionTint[a.type] ?? "text-zinc-300 bg-ink-700"}`}>
                    <Icon size={15} />
                  </span>
                  <span className="pill bg-ink-800 text-zinc-400 border border-ink-600 w-28 justify-center">{a.type.replace("_", " ")}</span>
                  <span className="flex-1 text-sm truncate">{a.summary}</span>
                  <span className={`pill ${a.by === "llm" ? "bg-fuchsia-400/15 text-fuchsia-300" : "bg-ink-800 text-zinc-400"}`}>{a.by}</span>
                  <span className="num text-xs text-zinc-500 w-16 text-right">{clockTime(a.t)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function ReorderPayload({ payload }: { payload: Record<string, unknown> }) {
  const lines = Array.isArray(payload.lines) ? (payload.lines as Record<string, unknown>[]) : null;
  const rest = Object.entries(payload).filter(([k]) => k !== "lines");
  return (
    <div className="space-y-2">
      {lines && (
        <table className="w-full text-xs">
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-ink-700/70">
                <td className="py-1 font-semibold capitalize">{String(l.name ?? l.item ?? "")}</td>
                <td className="py-1 num text-right">
                  {String(l.qty ?? "")} {String(l.unit ?? "")}
                </td>
                <td className="py-1 text-zinc-400 pl-3">{String(l.note ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rest.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-zinc-500 uppercase tracking-wider">{k.replace(/_/g, " ")}</dt>
            <dd className="text-zinc-200">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
