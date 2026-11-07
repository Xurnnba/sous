import { Brain, Ear, Receipt, Wind, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Sense, Severity } from "../types";

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

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm text-center py-8 px-4">{children}</div>;
}

export const senseIcon: Record<Sense, LucideIcon> = { hearing: Ear, smell: Wind, orders: Receipt, agent: Brain };

export const senseTint: Record<Sense, string> = {
  hearing: "text-sky-400 bg-sky-400/10",
  smell: "text-emerald-400 bg-emerald-400/10",
  orders: "text-accent-soft bg-accent/10",
  agent: "text-fuchsia-400 bg-fuchsia-400/10",
};

export const severityTint: Record<Severity, string> = {
  info: "text-zinc-400",
  warn: "text-warn",
  alert: "text-bad",
};

export function SenseIcon({ sense, size = 16 }: { sense: Sense; size?: number }) {
  const Icon = senseIcon[sense];
  return (
    <span className={`inline-flex items-center justify-center rounded-md p-1.5 ${senseTint[sense]}`}>
      <Icon size={size} />
    </span>
  );
}

export function Bar({ value, max, className = "", color = "bg-accent" }: { value: number; max: number; className?: string; color?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`h-2 rounded-full bg-ink-700 overflow-hidden ${className}`}>
      <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Tip({ text, children }: { text: string | null; children: ReactNode }) {
  if (!text) return <>{children}</>;
  return (
    <span className="relative group inline-flex">
      {children}
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-20 hidden group-hover:block w-64 rounded-lg bg-ink-700 border border-ink-600 px-3 py-2 text-xs text-zinc-200 shadow-xl">
        {text}
      </span>
    </span>
  );
}
