import { Check, ChevronDown, ChevronUp, Ear, Receipt, Sparkles, Wind, X } from "lucide-react";
import { useState } from "react";
import { ago, HEATER_STEPS_C, pct, smellKindLabel, titleCase, urgencyMeta } from "../lib/format";
import type { Item, ItemSense } from "../types";

const SENSE_CHIP: Record<ItemSense, { icon: typeof Ear; className: string; verb: string }> = {
  hearing: { icon: Ear, className: "bg-sky-500/15 text-sky-300 border-sky-500/40", verb: "heard at" },
  smell: { icon: Wind, className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40", verb: "smelled at" },
  orders: { icon: Receipt, className: "bg-accent/15 text-accent-soft border-accent/40", verb: "orders" },
};

const num = (v: unknown, digits = 0): string | null => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function MiniFingerprint({ values }: { values: number[] }) {
  // Values are either ratios (1.0 = clean) or log-ratios (0 = clean). Detect by range.
  const isLog = values.every((v) => Math.abs(v) < 0.9);
  const dev = values.map((v) => (isLog ? v : Math.log(Math.max(0.05, v))));
  const max = Math.max(0.3, ...dev.map((d) => Math.abs(d)));
  return (
    <div className="flex items-end gap-1 h-8" title="4-step heater sweep fingerprint">
      {dev.map((d, i) => {
        const h = Math.max(6, (Math.abs(d) / max) * 100);
        return (
          <div key={i} className="flex flex-col items-center gap-0.5 w-3">
            <div className="w-full flex items-end" style={{ height: 24 }}>
              <div className={`w-full rounded-sm ${d >= 0 ? "bg-accent" : "bg-sky-400"}`} style={{ height: `${h}%` }} />
            </div>
            <span className="text-[8px] text-zinc-500 num leading-none">{HEATER_STEPS_C[i] ?? ""}</span>
          </div>
        );
      })}
    </div>
  );
}

function Why({ item }: { item: Item }) {
  const e = item.evidence ?? {};
  if (item.sense === "hearing") {
    const parts = [str(e.how), num(e.confidence, 2) && `confidence ${num(e.confidence, 2)}`, str(e.heard_as) && `heard as ${str(e.heard_as)}`, num(e.db, 0) && `${num(e.db, 0)} dB`, str(e.mic) && `mic ${str(e.mic)}`].filter(Boolean);
    return (
      <div className="text-xs text-zinc-400 num">
        {parts.length ? parts.join(" · ") : "no evidence recorded"}
        {str(e.order_id) && <span className="ml-2 text-zinc-500">order {str(e.order_id)}</span>}
      </div>
    );
  }
  if (item.sense === "smell") {
    const fp = Array.isArray(e.ratios) ? (e.ratios as number[]) : Array.isArray(e.fingerprint) ? (e.fingerprint as number[]) : null;
    const probs = e.probs && typeof e.probs === "object" ? Object.entries(e.probs as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 2) : [];
    return (
      <div className="flex items-center gap-4 text-xs text-zinc-400">
        {fp && fp.length >= 3 && <MiniFingerprint values={fp.slice(0, 4)} />}
        <div className="space-y-0.5">
          {probs.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-28 truncate text-zinc-300">{smellKindLabel[k] ?? titleCase(k)}</span>
              <span className="num text-zinc-100 font-semibold">{pct(v)}</span>
            </div>
          ))}
          {!probs.length && num(e.confidence, 2) && <div>confidence {num(e.confidence, 2)}</div>}
          {e.single_channel === true && <div className="text-zinc-500">single-channel sensor — shape features unavailable</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="text-xs text-zinc-400 num">
      {str(e.ingredient) && <span className="capitalize text-zinc-300">{str(e.ingredient)}</span>}
      {num(e.minutes_to_stockout) && <span className="ml-2">stockout in {num(e.minutes_to_stockout)} min</span>}
      {num(e.on_hand, 1) && <span className="ml-2">· {num(e.on_hand, 1)} on hand</span>}
      {num(e.burn_rate_per_min, 2) && <span className="ml-2">· burn {num(e.burn_rate_per_min, 2)}/min</span>}
    </div>
  );
}

export function ItemCard({ item, now, onClose, compact = false }: { item: Item; now: number; onClose: (id: string, how: "done" | "dismiss") => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const m = urgencyMeta[item.urgency];
  const chip = SENSE_CHIP[item.sense];
  const Icon = chip.icon;
  const where = item.sense === "orders" ? "orders" : `${chip.verb} ${item.location ?? "kitchen"}`;
  return (
    <article className={`relative rounded-xl bg-ink-800 border border-ink-700 border-l-4 ${m.border} ${compact ? "p-3" : "p-4"} animate-slideIn`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className={`font-bold leading-tight ${compact ? "text-base" : "text-xl"}`}>{item.title}</h3>
        <span className="num text-[11px] text-zinc-500 whitespace-nowrap shrink-0 mt-1">{ago(item.updated || item.created, now)}</span>
      </div>
      {!compact && item.detail && <p className="text-sm text-zinc-400 leading-snug mt-1">{item.detail}</p>}
      <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
        <span className={`pill border normal-case tracking-normal gap-1 ${chip.className}`}>
          <Icon size={11} /> {where}
        </span>
        {item.count > 1 && <span className="pill bg-ink-700 text-zinc-200 num">×{item.count}</span>}
        {item.auto && (
          <span className="pill border border-accent/40 bg-accent/10 text-accent-soft normal-case tracking-normal gap-1 max-w-full" title={item.auto.summary}>
            <Sparkles size={11} /> <span className="truncate">Sous did: {item.auto.summary}</span>
          </span>
        )}
        <button className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-zinc-500 hover:text-zinc-200" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          why {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>
      {open && <div className="mt-2 pt-2 border-t border-ink-700/70">{<Why item={item} />}</div>}
      <div className="flex gap-2 mt-3">
        <button className="btn btn-on flex-1 justify-center py-1" onClick={() => onClose(item.id, "done")}>
          <Check size={14} /> Done
        </button>
        <button className="btn flex-1 justify-center py-1 text-zinc-300" onClick={() => onClose(item.id, "dismiss")}>
          <X size={14} /> Dismiss
        </button>
      </div>
    </article>
  );
}
