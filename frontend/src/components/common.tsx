import { Brain, Ear, Receipt, Wind, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { urgencyMeta } from "../lib/format";
import type { Sense, Severity, Urgency } from "../types";

export function Panel({ title, right, children, className = "" }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel p-4 flex flex-col min-h-0 ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between mb-3 gap-2">
          {title && <h2 className="panel-title">{title}</h2>}
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex-1 flex items-center justify-center text-zinc-500 text-sm text-center py-8 px-4 ${className}`}>{children}</div>;
}

export const senseIcon: Record<Sense, LucideIcon> = { hearing: Ear, smell: Wind, orders: Receipt, agent: Brain };

export const senseTint: Record<Sense, string> = {
  hearing: "text-sky-300/80 bg-sky-400/5",
  smell: "text-emerald-300/80 bg-emerald-400/5",
  orders: "text-accent-soft/80 bg-accent/5",
  agent: "text-violet-300/80 bg-violet-400/5",
};

export const severityTint: Record<Severity, string> = { info: "text-zinc-400", warn: "text-warn", alert: "text-bad" };

export function SenseIcon({ sense, size = 16 }: { sense: Sense; size?: number }) {
  const Icon = senseIcon[sense];
  return (
    <span className={`inline-flex items-center justify-center rounded-md p-1.5 ${senseTint[sense]}`}>
      <Icon size={size} />
    </span>
  );
}

export function Bar({ value, max, className = "", color = "bg-accent", height = "h-2" }: { value: number; max: number; className?: string; color?: string; height?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`${height} rounded-full bg-ink-700 overflow-hidden ${className}`}>
      <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Tip({ text, children }: { text: string | null; children: ReactNode }) {
  if (!text) return <>{children}</>;
  return (
    <span className="relative group inline-flex">
      {children}
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-20 hidden group-hover:block w-64 rounded-lg bg-ink-700 border border-ink-600 px-3 py-2 text-xs text-zinc-200 shadow-xl">{text}</span>
    </span>
  );
}

export function UrgencyPill({ urgency, className = "" }: { urgency: Urgency | "info"; className?: string }) {
  const m = urgency === "info" ? { text: "text-zinc-400", bg: "bg-zinc-500/15", label: "Info" } : urgencyMeta[urgency];
  return <span className={`pill ${m.bg} ${m.text} ${className}`}>{m.label}</span>;
}

/** Small key/value stat used across the sense pages. */
export function Stat({ label, value, sub, className = "" }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={`rounded-md bg-ink-800/60 px-3 py-2 ${className}`}>
      <div className="label">{label}</div>
      <div className="num text-base font-medium leading-tight text-zinc-200">{value}</div>
      {sub && <div className="text-[11px] text-zinc-400 mt-0.5">{sub}</div>}
    </div>
  );
}

/** Horizontal labelled bar (0..1 score). */
export function ScoreBar({ label, value, color = "bg-sky-400/70", highlight = false, format = (v: number) => v.toFixed(2) }: { label: string; value: number; color?: string; highlight?: boolean; format?: (v: number) => string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-24 truncate ${highlight ? "text-zinc-100 font-medium" : "text-zinc-500"}`} title={label}>
        {label}
      </span>
      <Bar value={value} max={1} className="flex-1" color={color} height="h-1.5" />
      <span className={`num w-10 text-right ${highlight ? "text-zinc-100 font-medium" : "text-zinc-500"}`}>{format(value)}</span>
    </div>
  );
}

export function Ring({ value, size = 56, stroke = 6, color = "#5fb58a", children }: { value: number; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#26262c" strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${v * c} ${c}`} className="transition-all duration-500" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}
