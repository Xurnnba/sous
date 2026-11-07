import { ArrowLeftRight, PackagePlus, Tag } from "lucide-react";
import { useState } from "react";
import { Empty, Tip } from "../components/common";
import { useSous } from "../hooks/useSous";
import { money2 } from "../lib/format";
import type { MenuItem } from "../types";

const ART: Record<string, string> = {
  "m-avo-toast": "from-lime-700/60 to-emerald-900/25",
  "m-guac": "from-green-700/60 to-emerald-950/25",
  "m-burger": "from-amber-700/60 to-orange-950/25",
  "m-fries": "from-yellow-600/60 to-amber-900/25",
  "m-chicken": "from-orange-700/60 to-red-950/25",
  "m-salad": "from-green-600/60 to-teal-900/25",
  "m-tomato-toast": "from-red-700/60 to-rose-950/25",
  "m-shake": "from-amber-500/60 to-yellow-900/25",
};

function Card({ item, byId, onRestore }: { item: MenuItem; byId: Map<string, MenuItem>; onRestore: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  // Hidden items never show a discount (backend zeroes it, but guard here too).
  const discount = item.available ? item.discount_pct : 0;
  const price = discount > 0 ? item.price * (1 - discount / 100) : item.price;
  const subFor = item.substitute_for ? byId.get(item.substitute_for)?.name ?? item.substitute_for : null;
  const art = ART[item.id] ?? "from-zinc-700/60 to-zinc-900/25";
  return (
    <Tip text={item.reason}>
      <article className={`relative w-full rounded-lg overflow-hidden border bg-ink-800 transition-all duration-700 ${item.available ? "border-ink-700 opacity-100 scale-100" : "border-ink-700/60 opacity-45 grayscale scale-[0.98]"}`}>
        <div className={`relative h-28 bg-gradient-to-br ${art} flex items-end p-3`}>
          {item.emoji && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ background: "radial-gradient(circle at 50% 45%, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 38%, transparent 70%)" }}>
              <span className="text-5xl leading-none select-none" role="img" aria-label={item.name}>
                {item.emoji}
              </span>
            </div>
          )}
          <div className="relative flex gap-1 flex-wrap">
            {item.tags.map((t) => (
              <span key={t} className="pill bg-black/30 text-zinc-400">
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-base font-medium leading-tight text-zinc-200">{item.name}</h3>
            <div className="text-right shrink-0">
              {discount > 0 && <div className="text-xs text-zinc-500 line-through num">{money2(item.price)}</div>}
              <div className="num text-base font-semibold text-zinc-100">{money2(price)}</div>
            </div>
          </div>
          <p className="text-xs text-zinc-400 mt-1">{item.ingredients.map((i) => i.label ?? i.name).join(" · ")}</p>
          <div className="flex gap-2 flex-wrap mt-3 min-h-[22px]">
            {discount > 0 && (
              <span className="pill bg-ok/10 text-ok gap-1">
                <Tag size={11} /> {discount}% off
              </span>
            )}
            {subFor && (
              <span className="pill bg-ink-700/60 text-zinc-300 gap-1">
                <ArrowLeftRight size={11} className="text-accent" /> Suggested instead of {subFor}
              </span>
            )}
          </div>
        </div>
        {!item.available && (
          <>
            <div className="absolute top-2 right-2 pill bg-ink-900/80 text-zinc-300 pointer-events-none">Unavailable</div>
            <div className="absolute inset-x-0 bottom-0 p-3 flex justify-end bg-gradient-to-t from-black/50 to-transparent">
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
            <div className="label">Customer view · live storefront</div>
            <h1 className="text-2xl font-semibold">Sous Test Kitchen</h1>
            <p className="text-sm text-zinc-400 mt-1">What a DoorDash / Uber Eats customer sees right now. Items change the moment the agent acts.</p>
          </div>
          <div className="text-right text-sm text-zinc-400">
            <div>
              <span className="num text-xl font-semibold text-zinc-100">{state.menu.length - hidden}</span> available
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
