import { Ear, Receipt, Wind } from "lucide-react";
import { pct, smellKindLabel } from "../lib/format";
import type { State } from "../types";

type Tone = "ok" | "warn" | "bad" | "muted";
const toneCls: Record<Tone, string> = { ok: "border-ok/40 text-ok", warn: "border-warn/50 text-warn", bad: "border-bad/50 text-bad", muted: "border-ink-600 text-zinc-500" };

function Pill({ icon: Icon, name, tone, main, sub, href }: { icon: typeof Ear; name: string; tone: Tone; main: string; sub?: string; href: string }) {
  return (
    <a href={href} className={`flex items-center gap-3 rounded-xl border bg-ink-900 px-4 py-2.5 min-w-0 hover:bg-ink-800 transition-colors ${toneCls[tone]}`}>
      <Icon size={22} className="shrink-0" />
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-[0.25em] text-zinc-500 leading-none">{name}</div>
        <div className="text-base font-bold leading-tight truncate text-zinc-100">{main}</div>
        {sub && <div className="text-[11px] text-zinc-400 truncate leading-tight">{sub}</div>}
      </div>
    </a>
  );
}

/** The three compact sense status pills across the top of the Board. */
export function SensePills({ state, listening }: { state: State; listening: boolean }) {
  const ears = state.senses.ears;
  const live = ears.mics.filter((m) => m.active);
  const earsMain = live.length ? `${live.length} mic${live.length === 1 ? "" : "s"} listening` : listening ? "connecting mic…" : "no mic — tap Listen";
  const earsSub = live.length ? `model ${ears.model} · ${live.map((m) => m.location).join(", ")}` : state.providers.ears === "loading" ? "model loading" : undefined;

  const smell = state.senses.smell;
  const noseTone: Tone = smell.status === "anomaly" ? (smell.anomaly?.urgency === "now" ? "bad" : "warn") : smell.status === "nominal" ? "ok" : smell.status === "offline" ? "muted" : "warn";
  const noseMain = smell.status === "anomaly" && smell.anomaly ? `${smellKindLabel[smell.anomaly.kind] ?? smell.anomaly.kind.replace(/_/g, " ")} at ${smell.location}` : `${smell.status} at ${smell.location}`;
  const noseSub = `calibration ${pct(smell.calibration.quality)} · ${smell.device}`;

  const open = state.orders.filter((o) => o.status !== "picked_up").length;
  const nextOut = state.inventory.filter((i) => i.minutes_to_stockout !== null).sort((a, b) => (a.minutes_to_stockout ?? 1e9) - (b.minutes_to_stockout ?? 1e9))[0];
  const mins = nextOut?.minutes_to_stockout ?? null;
  const ordersTone: Tone = mins !== null && mins <= 10 ? "bad" : mins !== null && mins <= 30 ? "warn" : open > 8 ? "warn" : "ok";
  const ordersSub = nextOut && mins !== null && mins <= 60 ? `next stockout: ${nextOut.label ?? nextOut.name} in ${Math.round(mins)} min` : "no stockout within an hour";

  return (
    <div className="grid grid-cols-3 gap-3">
      <Pill icon={Ear} name="Ears" tone={live.length ? "ok" : "muted"} main={earsMain} sub={earsSub} href="#/ears" />
      <Pill icon={Wind} name="Nose" tone={noseTone} main={noseMain} sub={noseSub} href="#/nose" />
      <Pill icon={Receipt} name="Orders" tone={ordersTone} main={`${open} open ticket${open === 1 ? "" : "s"}${state.rush ? " · rush" : ""}`} sub={ordersSub} href="#/kitchen" />
    </div>
  );
}
