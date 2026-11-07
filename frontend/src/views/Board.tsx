import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { Empty } from "../components/common";
import { ItemCard } from "../components/ItemCard";
import { SensePills } from "../components/SensePills";
import { VoicePanel } from "../components/VoicePanel";
import { useNow } from "../hooks/useNow";
import { useSous } from "../hooks/useSous";
import type { VoiceState } from "../hooks/useVoice";
import { urgencyMeta } from "../lib/format";
import type { Item, Urgency } from "../types";

const COLUMNS: Urgency[] = ["now", "next", "today"];

function byRecency(a: Item, b: Item): number {
  return new Date(b.updated).getTime() - new Date(a.updated).getTime();
}

export function Board({ voice, listening }: { voice: VoiceState; listening: boolean }) {
  const { state, actions, closeItem } = useSous();
  const now = useNow(1000);
  const [laterOpen, setLaterOpen] = useState(false);
  if (!state) return <Empty>Waiting for Sous…</Empty>;

  const open = state.items.open;
  const later = open.filter((i) => i.urgency === "later").sort(byRecency);
  const lastSpeak = actions.find((a) => a.type === "speak") ?? state.actions.find((a) => a.type === "speak");
  const phrasedByLlm = state.providers.llm !== "rules" && lastSpeak?.by === "llm";

  return (
    <div className="h-full px-6 py-4 flex flex-col">
      <div className="max-w-[1400px] w-full mx-auto flex flex-col gap-4 flex-1 min-h-0">
        <div className="shrink-0">
          <SensePills state={state} listening={listening} />
        </div>

        {/* Columns scroll internally so the Later row and Sous says stay on the single screen. */}
        <div className="grid grid-cols-3 gap-4 flex-1 min-h-0">
          {COLUMNS.map((u) => {
            const m = urgencyMeta[u];
            const list = open.filter((i) => i.urgency === u).sort(byRecency);
            return (
              <section key={u} className="panel p-3 flex flex-col min-h-0">
                <header className="flex items-baseline justify-between px-1 mb-2 shrink-0">
                  <h2 className="text-sm font-medium text-zinc-300 inline-flex items-center">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 ${m.dot}`} />
                    {m.label}
                  </h2>
                  <span className="num text-sm text-zinc-500">{list.length}</span>
                </header>
                <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto pr-1">
                  {list.length === 0 ? <Empty>{m.empty}</Empty> : list.map((it) => <ItemCard key={it.id} item={it} now={now} onClose={closeItem} />)}
                </div>
              </section>
            );
          })}
        </div>

        <section className="panel p-3 shrink-0 max-h-[30%] overflow-y-auto">
          <button className="w-full flex items-center justify-between px-1 text-left" onClick={() => setLaterOpen((o) => !o)} aria-expanded={laterOpen}>
            <span className="text-sm font-medium text-zinc-400 inline-flex items-center">
              <span className="inline-block w-1.5 h-1.5 rounded-full mr-2 bg-zinc-600" />
              Later · <span className="num">{later.length}</span>
            </span>
            <span className="inline-flex items-center gap-2 text-xs text-zinc-500">
              {!laterOpen && later.length > 0 && <span className="truncate max-w-[520px]">{later.map((i) => i.title).join(" · ")}</span>}
              {laterOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </span>
          </button>
          {laterOpen && (
            <div className="grid grid-cols-3 gap-3 mt-3">
              {later.length === 0 ? <Empty className="col-span-3 py-4">{urgencyMeta.later.empty}</Empty> : later.map((it) => <ItemCard key={it.id} item={it} now={now} onClose={closeItem} compact />)}
            </div>
          )}
        </section>

        <div className="shrink-0">
          <VoicePanel voice={voice} lastLine={state.voice.last_line} phrasedByLlm={phrasedByLlm} />
        </div>
      </div>
    </div>
  );
}
