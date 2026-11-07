import { ArrowLeftRight, PackagePlus, Tag } from "lucide-react";
import { useState } from "react";
import { Empty, Tip } from "../components/common";
import { useSous } from "../hooks/useSous";
import { money2 } from "../lib/format";
import type { MenuItem } from "../types";

const ART: Record<string, string> = {
  "m-avo-toast": "from-lime-700/60 to-emerald-900/60",
  "m-guac": "from-green-700/60 to-emerald-950/60",
  "m-burger": "from-amber-700/60 to-orange-950/60",
  "m-fries": "from-yellow-600/60 to-amber-900/60",
  "m-chicken": "from-orange-700/60 to-red-950/60",
  "m-salad": "from-green-600/60 to-teal-900/60",
  "m-tomato-toast": "from-red-700/60 to-rose-950/60",
  "m-shake": "from-amber-500/60 to-yellow-900/60",
};

function Card({ item, byId, onRestore }: { item: MenuItem; byId: Map<string, MenuItem>; onRestore: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  // Hidden items never show a discount (backend zeroes it, but guard here too).
  const discount = item.available ? item.discount_pct : 0;
  const price = discount > 0 ? item.price * (1 - discount / 100) : item.price;
  const subFor = item.substitute_for ? byId.get(item.substitute_for)?.name ?? item.substitute_for : null;
  const art = ART[item.id] ?? "from-zinc-700/60 to-zinc-900/60";
  return (
    <Tip text={item.reason}>
      <article className={`relative w-full rounded-2xl overflow-hidden border bg-ink-800 transition-all duration-700 ${item.available ? "border-ink-700 opacity-100 scale-100" : "border-ink-700/60 opacity-45 grayscale scale-[0.98]"}`}>
        <div className={`relative h-28 bg-gradient-to-br ${art} flex items-end p-3`}>
          {item.emoji && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ background: "radial-gradient(circle at 50% 45%, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.04) 38%, transparent 70%)" }}>
              <span className="text-6xl leading-none select-none drop-shadow-[0_6px_14px_rgba(0,0,0,0.45)]" role="img" aria-label={item.name}>
                {item.emoji}
              </span>
            </div>
          )}
          <div className="relative flex gap-1 flex-wrap">
            {item.tags.map((t) => (
              <span key={t} className="pill bg-black/40 text-zinc-200 backdrop-blur">
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-lg font-bold leading-tight">{item.name}</h3>
            <div className="text-right shrink-0">
              {discount > 0 && <div className="text-xs text-zinc-500 line-through num">{money2(item.price)}</div>}
              <div className="num text-lg font-bold">{money2(price)}</div>
            </div>
          </div>
          <p className="text-xs text-zinc-400 mt-1">{item.ingredients.map((i) => i.label ?? i.name).join(" · ")}</p>
          <div className="flex gap-2 flex-wrap mt-3 min-h-[22px]">
            {discount > 0 && (
              <span className="pill bg-ok/20 text-ok border border-ok/40 gap-1">
                <Tag size={11} /> {discount}% off
              </span>
            )}
            {subFor && (
              <span className="pill bg-accent/20 text-accent-soft border border-accent/40 gap-1 normal-case tracking-normal">
                <ArrowLeftRight size={11} /> Suggested instead of {subFor}
              </span>
            )}
          </div>
        </div>
        {!item.available && (
          <>
            <div className="absolute top-11 -right-[42px] w-56 text-center rotate-45 bg-zinc-200 text-black text-[10px] uppercase font-black tracking-wider py-1 shadow pointer-events-none">Currently unavailable</div>
            <div className="absolute inset-x-0 bottom-0 p-3 flex justify-end bg-gradient-to-t from-black/70 to-transparent">
              <button
                className="btn btn-accent text-xs opacity-100 !grayscale-0"
                disabled={busy}
                onClick={async (e) => {
                  e.stopPropagation();
                  setBusy(true);
                  try {
                    await onRestore(item.id);
                  } finally {
                    setBusy(false);
                  }
                }}
                title="Staff override: restore this item on the storefront"
              >
                <PackagePlus size={14} /> We got more
              </button>
            </div>
          </>
        )}
      </article>
    </Tip>
  );
}

export function Storefront() {
  const { state, api } = useSous();
  if (!state) return <Empty>Loading the storefront…</Empty>;
  const byId = new Map(state.menu.map((m) => [m.id, m]));
  const sorted = [...state.menu].sort((a, b) => Number(b.available) - Number(a.available) || Number(!!b.substitute_for) - Number(!!a.substitute_for));
  const hidden = state.menu.filter((m) => !m.available).length;
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto">
        <header className="flex items-end justify-between mb-6 flex-wrap gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Customer view · live storefront</div>
            <h1 className="text-3xl font-black">Sous Test Kitchen</h1>
            <p className="text-sm text-zinc-400 mt-1">What a DoorDash / Uber Eats customer sees right now. Items change the moment the agent acts.</p>
          </div>
          <div className="text-right text-sm text-zinc-400">
            <div>
              <span className="num text-2xl font-black text-zinc-100">{state.menu.length - hidden}</span> available
            </div>
            {hidden > 0 && <div className="text-bad">{hidden} hidden by Sous</div>}
          </div>
        </header>
        {sorted.length === 0 ? (
          <Empty>The menu is empty. Items appear here once the backend publishes a menu.</Empty>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {sorted.map((m) => (
              <Card key={m.id} item={m} byId={byId} onRestore={api.restoreMenuItem} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
