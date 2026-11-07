import { Bike, Flame } from "lucide-react";
import { EventFeed } from "../components/EventFeed";
import { NoiseMeter, StressGauge } from "../components/Gauges";
import { Empty, Panel } from "../components/common";
import { useSous } from "../hooks/useSous";
import { channelMeta, countdown, riskBorder, riskColor, simClock } from "../lib/format";
import type { Order, OrderStatus } from "../types";

const COLUMNS: { status: OrderStatus; title: string; tint: string }[] = [
  { status: "queued", title: "Queued", tint: "text-zinc-300" },
  { status: "fire", title: "Fire now", tint: "text-accent-soft" },
  { status: "cooking", title: "Cooking", tint: "text-warn" },
  { status: "ready", title: "Ready", tint: "text-ok" },
];

function OrderCard({ order, now }: { order: Order; now: number }) {
  const remaining = order.promised_at - now;
  const fire = order.status !== "ready" && order.status !== "picked_up" && order.fire_at <= now && order.status !== "cooking";
  const ch = channelMeta[order.channel];
  return (
    <article className={`relative rounded-xl bg-ink-800 border border-ink-700 border-l-4 ${riskBorder[order.late_risk]} p-3 animate-slideIn ${order.status === "fire" ? "border-accent/70 animate-fireBorder" : fire ? "ring-2 ring-accent animate-firePulse" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="num text-3xl font-black leading-none">{order.id}</span>
        <span className={`pill ${ch.className}`}>{ch.label}</span>
      </div>
      <ul className="mt-2 space-y-0.5">
        {order.items.map((it, i) => (
          <li key={i} className="text-base leading-tight">
            <span className="num text-zinc-400 mr-1.5">{it.qty}×</span>
            {it.name}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-end justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500">{remaining < 0 ? "Late by" : "Due in"}</div>
          <div className={`num text-2xl font-bold leading-none ${remaining < 0 ? "text-bad" : riskColor[order.late_risk]}`}>{countdown(Math.abs(remaining))}</div>
        </div>
        <div className="text-right text-xs text-zinc-400 space-y-0.5">
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
      {fire && (
        <div className="absolute -top-2 -right-2 inline-flex items-center gap-1 bg-accent text-black text-xs font-black px-2 py-0.5 rounded-md shadow">
          <Flame size={12} /> FIRE
        </div>
      )}
    </article>
  );
}

export function Kitchen() {
  const { state, events } = useSous();
  if (!state) return <Empty>Waiting for the kitchen state…</Empty>;
  const now = state.sim_minutes;
  const active = state.orders.filter((o) => o.status !== "picked_up");
  return (
    <div className="h-full grid grid-cols-[1fr_320px] gap-4 p-4 min-h-0">
      <div className="grid grid-cols-4 gap-3 min-h-0">
        {COLUMNS.map((col) => {
          const list = active.filter((o) => o.status === col.status).sort((a, b) => a.promised_at - b.promised_at);
          return (
            <div key={col.status} className="flex flex-col min-h-0 panel p-3">
              <header className="flex items-baseline justify-between mb-2">
                <h2 className={`text-sm font-black uppercase tracking-[0.18em] ${col.tint}`}>{col.title}</h2>
                <span className="num text-2xl font-black text-zinc-500">{list.length}</span>
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
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Kitchen clock</div>
                <div className="num text-3xl font-black">{simClock(now)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Open tickets</div>
                <div className="num text-3xl font-black">{active.length}</div>
              </div>
            </div>
          </div>
          <div className="mt-4">
            <NoiseMeter db={state.senses.hearing.noise_db} active={state.senses.hearing.active} />
          </div>
        </Panel>
        <Panel title="Live feed" className="flex-1" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">ears · nose · orders · brain</span>}>
          <EventFeed events={events} />
        </Panel>
      </aside>
    </div>
  );
}
