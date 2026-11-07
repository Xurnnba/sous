import { Building2, ChefHat, Radar, Store } from "lucide-react";
import type { ConnectionStatus } from "../types";

export type View = "kitchen" | "storefront" | "backoffice" | "senses";

export const VIEWS: { id: View; label: string; icon: typeof ChefHat }[] = [
  { id: "kitchen", label: "Kitchen", icon: ChefHat },
  { id: "storefront", label: "Storefront", icon: Store },
  { id: "backoffice", label: "Back Office", icon: Building2 },
  { id: "senses", label: "Senses", icon: Radar },
];

export function TopNav({ view, onChange, status }: { view: View; onChange: (v: View) => void; status: ConnectionStatus }) {
  const dot = status === "open" || status === "mock" ? "bg-ok" : status === "connecting" ? "bg-warn animate-pulse" : "bg-bad";
  const label = status === "mock" ? "mock backend" : status === "open" ? "live" : status === "connecting" ? "connecting" : "reconnecting";
  return (
    <div className="flex items-center gap-6 px-5 h-14 border-b border-ink-700 bg-ink-900 shrink-0">
      <div className="flex items-baseline gap-3 shrink-0">
        <span className="text-2xl font-black tracking-[0.2em] text-accent">SOUS</span>
        <span className="hidden lg:inline text-xs text-zinc-400 italic">the kitchen's other senses</span>
      </div>
      <nav className="flex items-center gap-1">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          const active = v.id === view;
          return (
            <button
              key={v.id}
              onClick={() => onChange(v.id)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${active ? "bg-accent/15 text-accent-soft" : "text-zinc-400 hover:text-zinc-100 hover:bg-ink-800"}`}
            >
              <Icon size={16} />
              {v.label}
            </button>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        {label}
      </div>
    </div>
  );
}
