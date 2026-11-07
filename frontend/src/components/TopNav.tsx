import { ChefHat, Ear, LayoutList, Map as MapIcon, Smartphone, Store, Wind } from "lucide-react";

export type View = "board" | "ears" | "nose" | "kitchen" | "storefront" | "sounds" | "room";

export const VIEWS: { id: View; label: string; icon: typeof ChefHat }[] = [
  { id: "board", label: "Board", icon: LayoutList },
  { id: "ears", label: "Ears", icon: Ear },
  { id: "nose", label: "Nose", icon: Wind },
  { id: "room", label: "Scent room", icon: MapIcon },
  { id: "kitchen", label: "Orders", icon: ChefHat },
  { id: "storefront", label: "Storefront", icon: Store },
  { id: "sounds", label: "Sounds", icon: Smartphone },
];

export function TopNav({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="flex items-center gap-6 px-5 h-12 border-b border-ink-800 bg-ink-950 shrink-0">
      <div className="flex items-baseline gap-3 shrink-0">
        <span className="text-base font-semibold tracking-wide text-zinc-100">Sous</span>
        <span className="hidden lg:inline text-xs text-zinc-500">the kitchen's other senses</span>
      </div>
      <nav className="flex items-center gap-1">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          const active = v.id === view;
          return (
            <button
              key={v.id}
              onClick={() => onChange(v.id)}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${active ? "bg-ink-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200 hover:bg-ink-900"}`}
            >
              <Icon size={15} />
              {v.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
