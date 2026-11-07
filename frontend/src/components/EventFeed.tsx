import { clockTime } from "../lib/format";
import type { Event } from "../types";
import { Empty, SenseIcon, severityTint } from "./common";

export function EventFeed({ events, limit = 40, compact = false }: { events: Event[]; limit?: number; compact?: boolean }) {
  if (!events.length) return <Empty>No events yet. The feed fills as the ears, nose and order stream report in.</Empty>;
  return (
    <ul className="flex flex-col gap-1.5 overflow-y-auto pr-1 flex-1 min-h-0">
      {events.slice(0, limit).map((e) => (
        <li key={e.id} className={`flex gap-3 items-start rounded-lg px-2 py-2 animate-slideIn ${e.severity === "alert" ? "bg-bad/[0.07]" : ""}`}>
          <SenseIcon sense={e.sense} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className={`font-medium text-sm min-w-0 break-words ${severityTint[e.severity]} ${e.severity === "info" ? "!text-zinc-200" : ""}`}>{e.label}</span>
              <span className="num text-[11px] text-zinc-500 shrink-0">{clockTime(e.t)}</span>
            </div>
            {!compact && <p className="text-xs text-zinc-400 leading-snug mt-0.5">{e.detail}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}
