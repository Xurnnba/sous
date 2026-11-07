import { ArrowLeftRight, Bike, Brain, ChevronDown, ChevronUp, ClipboardList, EyeOff, Flame, HandHelping, MessageSquare, Percent, RotateCcw, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Bar as RBar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Bar, Empty, Panel } from "../components/common";
import { EventFeed } from "../components/EventFeed";
import { NoiseMeter, StressGauge } from "../components/Gauges";
import { useSous } from "../hooks/useSous";
import { channelMeta, clockTime, countdown, freshnessClass, minutesToStockoutColor, money, riskBorder, riskColor, simClock } from "../lib/format";
import type { Order, OrderStatus } from "../types";

const COLUMNS: { status: OrderStatus; title: string; tint: string }[] = [
  { status: "queued", title: "Queued", tint: "bg-zinc-500" },
  { status: "fire", title: "Fire now", tint: "bg-accent" },
  { status: "cooking", title: "Cooking", tint: "bg-warn" },
  { status: "ready", title: "Ready", tint: "bg-ok" },
];

const actionIcon: Record<string, LucideIcon> = {
  menu_hide: EyeOff,
  menu_restore: RotateCcw,
  menu_discount: Percent,
  substitute: ArrowLeftRight,
  reorder_draft: ClipboardList,
  fire_now: Flame,
  ask_human: HandHelping,
  speak: MessageSquare,
};

const actionTint: Record<string, string> = {
  menu_hide: "text-bad bg-bad/10",
  menu_restore: "text-ok bg-ok/10",
  menu_discount: "text-ok bg-ok/10",
  substitute: "text-accent-soft bg-accent/10",
  reorder_draft: "text-[#7aa7c7] bg-[#7aa7c7]/10",
  fire_now: "text-accent-soft bg-accent/10",
  ask_human: "text-warn bg-warn/10",
  speak: "text-zinc-300 bg-ink-700",
};

function OrderCard({ order, now }: { order: Order; now: number }) {
  const remaining = order.promised_at - now;
  const fire = order.status !== "ready" && order.status !== "picked_up" && order.fire_at <= now && order.status !== "cooking";
  const ch = channelMeta[order.channel];
  return (
    <article className={`relative rounded-lg bg-ink-800 border border-ink-700 border-l-2 ${riskBorder[order.late_risk]} p-3 animate-slideIn ${fire ? "animate-fireBorder" : order.status === "fire" ? "border-accent/25" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="num text-lg font-semibold leading-none text-zinc-100">{order.id}</span>
        <span className="flex items-center gap-1 shrink-0">
          {fire && (
            <span className="pill bg-accent/10 text-accent-soft gap-1">
              <Flame size={11} /> Fire
            </span>
          )}
          <span className={`pill ${ch.className}`}>{ch.label}</span>
        </span>
      </div>
      <ul className="mt-2 space-y-0.5">
        {order.items.map((it, i) => (
          <li key={i} className="text-sm leading-tight text-zinc-300">
            <span className="num text-zinc-500 mr-1.5">{it.qty}×</span>
            {it.name}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-end justify-between gap-2">
        <div>
          <div className="label">{remaining < 0 ? "Late by" : "Due in"}</div>
          <div className={`num text-lg font-medium leading-none ${remaining < 0 ? "text-bad" : riskColor[order.late_risk]}`}>{countdown(Math.abs(remaining))}</div>
        </div>
        <div className="text-right text-xs text-zinc-500 space-y-0.5">
          {order.dasher_eta_min !== null && (
            <div className="inline-flex items-center gap-1">
              <Bike size={12} /> <span className="num">{Math.round(order.dasher_eta_min)} min</span>
            </div>
          )}
          <div>
            fire @ <span className="num">{simClock(order.fire_at)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel p-4">
      <div className="label">{label}</div>
      <div className="num text-2xl font-semibold text-zinc-100 mt-1">{value}</div>
      {sub && <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export function Kitchen() {
  const { state, events, actions } = useSous();
  const [invOpen, setInvOpen] = useState(false);
  if (!state) return <Empty>Waiting for the kitchen state…</Empty>;
  const now = state.sim_minutes;
  const active = state.orders.filter((o) => o.status !== "picked_up");

  const inv = [...state.inventory].sort((a, b) => (a.minutes_to_stockout ?? 1e9) - (b.minutes_to_stockout ?? 1e9));
  const forecast = inv
    .filter((i) => i.minutes_to_stockout !== null)
    .slice(0, 8)
    .map((i) => ({ name: i.label ?? i.name, minutes: Math.min(180, i.minutes_to_stockout ?? 0), raw: i.minutes_to_stockout ?? 0 }));
  const log = actions.length ? actions : state.actions;
  const reorder = log.find((a) => a.type === "reorder_draft");
  const soonest = inv[0];

  return (
    <div className="h-full overflow-y-auto p-4 flex flex-col gap-4">
      <div className="text-xs text-zinc-500 -mb-2 shrink-0">Orders · live tickets → recipe-level inventory → stockout forecast</div>
      {/* ORDER BOARD */}
      <div className="grid grid-cols-[1fr_320px] gap-4 min-h-[540px] h-[calc(100vh-250px)] shrink-0">
        <div className="grid grid-cols-4 gap-3 min-h-0">
          {COLUMNS.map((col) => {
            const list = active.filter((o) => o.status === col.status).sort((a, b) => a.promised_at - b.promised_at);
            return (
              <div key={col.status} className="flex flex-col min-h-0 panel p-3">
                <header className="flex items-baseline justify-between mb-2">
                  <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                    <span className={`h-1.5 w-1.5 rounded-full ${col.tint}`} />
                    {col.title}
                  </h2>
                  <span className="num text-sm text-zinc-500">{list.length}</span>
                </header>
                <div className="flex flex-col gap-3 overflow-y-auto pr-1 flex-1 min-h-0">
                  {list.length === 0 ? <Empty>{col.status === "queued" ? "No tickets waiting" : col.status === "fire" ? "Nothing to fire" : col.status === "cooking" ? "Nothing on the burners" : "Pass is clear"}</Empty> : list.map((o) => <OrderCard key={o.id} order={o} now={now} />)}
                </div>
              </div>
            );
          })}
        </div>
        <aside className="flex flex-col gap-4 min-h-0">
          <Panel>
            <div className="grid grid-cols-2 gap-4 items-center">
              <StressGauge value={state.senses.hearing.stress} />
              <div className="space-y-3">
                <div>
                  <div className="label">Kitchen clock</div>
                  <div className="num text-2xl font-semibold text-zinc-100">{simClock(now)}</div>
                </div>
                <div>
                  <div className="label">Open tickets</div>
                  <div className="num text-2xl font-medium text-zinc-200">{active.length}</div>
                </div>
              </div>
            </div>
            <div className="mt-4">
              <NoiseMeter db={state.senses.hearing.noise_db} active={state.senses.hearing.active} />
            </div>
          </Panel>
          <Panel title="Live feed" className="flex-1" right={<span className="label">ears · nose · orders · brain</span>}>
            <EventFeed events={events} />
          </Panel>
        </aside>
      </div>

      {/* INVENTORY & FORECAST (collapsible) */}
      <section className="panel">
        <button className="w-full flex items-center justify-between px-4 py-3 text-left" onClick={() => setInvOpen((o) => !o)} aria-expanded={invOpen}>
          <div className="flex items-baseline gap-4">
            <h2 className="text-sm font-medium text-zinc-300">Inventory &amp; forecast</h2>
            {!invOpen && soonest && soonest.minutes_to_stockout !== null && (
              <span className="text-xs text-zinc-400">
                next stockout: <span className={`font-medium capitalize ${minutesToStockoutColor(soonest.minutes_to_stockout)}`}>{soonest.label ?? soonest.name}</span> in <span className="num">{soonest.minutes_to_stockout}</span> min · {state.metrics.stockouts_prevented} prevented · {money(state.metrics.est_refunds_avoided_usd)} refunds avoided
              </span>
            )}
          </div>
          {invOpen ? <ChevronUp size={18} className="text-zinc-400" /> : <ChevronDown size={18} className="text-zinc-400" />}
        </button>
        {invOpen && (
          <div className="px-4 pb-4 flex flex-col gap-4">
            <div className="grid grid-cols-4 gap-4">
              <Tile label="Orders served" value={String(state.metrics.orders_served)} sub="since open" />
              <Tile label="Stockouts prevented" value={String(state.metrics.stockouts_prevented)} sub="items pulled before 86" />
              <Tile label="Refunds avoided" value={money(state.metrics.est_refunds_avoided_usd)} sub="estimated" />
              <Tile label="Waste saved" value={money(state.metrics.est_waste_saved_usd)} sub="estimated" />
            </div>

            <div className="grid grid-cols-[1.4fr_1fr] gap-4">
              <Panel title="Inventory" right={<span className="label">recipe-level burn</span>}>
                {inv.length === 0 ? (
                  <Empty>No inventory loaded yet.</Empty>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="label">
                      <tr className="text-left">
                        <th className="py-1 font-normal">Ingredient</th>
                        <th className="py-1 font-normal w-44">On hand / par</th>
                        <th className="py-1 font-normal text-right">Burn / min</th>
                        <th className="py-1 font-normal text-right">To stockout</th>
                        <th className="py-1 font-normal">Freshness</th>
                        <th className="py-1 font-normal">Where</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inv.map((i) => {
                        const p = i.par ? i.on_hand / i.par : 0;
                        return (
                          <tr key={i.name} className="border-t border-ink-700/70">
                            <td className="py-2 capitalize text-zinc-200">{i.label ?? i.name}</td>
                            <td className="py-2">
                              <div className="flex items-center gap-2">
                                <Bar value={i.on_hand} max={i.par} className="flex-1" color={p < 0.2 ? "bg-bad" : p < 0.45 ? "bg-warn" : "bg-ok"} />
                                <span className="num text-xs text-zinc-300 w-20 text-right">
                                  {Math.round(i.on_hand)}/{i.par} {i.unit}
                                </span>
                              </div>
                            </td>
                            <td className="py-2 text-right num text-zinc-300">{i.burn_rate_per_min.toFixed(2)}</td>
                            <td className={`py-2 text-right num font-medium ${minutesToStockoutColor(i.minutes_to_stockout)}`}>{i.minutes_to_stockout === null ? "—" : `${i.minutes_to_stockout} min`}</td>
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

              <div className="flex flex-col gap-4">
                <Panel title="Stockout forecast" right={<span className="label">minutes at current burn</span>}>
                  {forecast.length === 0 ? (
                    <Empty>No burn data yet.</Empty>
                  ) : (
                    <div className="h-[260px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={forecast} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                          <CartesianGrid horizontal={false} stroke="#26262c" />
                          <XAxis type="number" domain={[0, 180]} tick={{ fill: "#52525b", fontSize: 11 }} stroke="#26262c" />
                          <YAxis type="category" dataKey="name" width={90} tick={{ fill: "#a1a1aa", fontSize: 12 }} stroke="#26262c" />
                          <Tooltip cursor={{ fill: "#1a1a1e" }} contentStyle={{ background: "#1a1a1e", border: "1px solid #26262c", borderRadius: 8, fontSize: 12 }} formatter={(_v, _n, p) => [`${(p.payload as { raw: number }).raw} min`, "to stockout"]} />
                          <RBar dataKey="minutes" radius={[0, 3, 3, 0]} isAnimationActive={false}>
                            {forecast.map((f) => (
                              <Cell key={f.name} fill={f.raw <= 10 ? "#e06c66" : f.raw <= 30 ? "#d6a548" : "#3f3f46"} />
                            ))}
                          </RBar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </Panel>
                <Panel title="Reorder draft" right={<ClipboardList size={16} className="text-zinc-500" />}>
                  {!reorder ? (
                    <Empty>No reorder drafted yet. Sous drafts one when an ingredient is forecast to run out.</Empty>
                  ) : (
                    <div className="text-sm space-y-2">
                      <p className="font-medium text-zinc-200">{reorder.summary}</p>
                      <ReorderPayload payload={reorder.payload} />
                      <div className="text-xs text-zinc-500">
                        drafted {clockTime(reorder.t)} by {reorder.by} · awaiting manager approval
                      </div>
                    </div>
                  )}
                </Panel>
              </div>
            </div>

            <Panel title="Actions log" right={<span className="label">{log.length} actions</span>}>
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
                        <span className="pill bg-ink-800 text-zinc-500 border border-ink-700 w-28 justify-center">{a.type.replace("_", " ")}</span>
                        <span className="flex-1 text-sm truncate text-zinc-200">{a.summary}</span>
                        <span className={`pill ${a.by === "llm" ? "bg-ink-800 text-[#7aa7c7]" : "bg-ink-800 text-zinc-500"}`}>{a.by}</span>
                        <span className="num text-xs text-zinc-500 w-16 text-right">{clockTime(a.t)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </div>
        )}
      </section>
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
                <td className="py-1 font-medium capitalize">{String(l.name ?? l.item ?? "")}</td>
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
            <dt className="text-zinc-500">{k.replace(/_/g, " ")}</dt>
            <dd className="text-zinc-200">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
