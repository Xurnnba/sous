import { ClipboardList, Ear, EyeOff, Flame, Hand, ReceiptText, RotateCcw, Shuffle, Store, Tag, Volume2, VolumeX, Wind } from "lucide-react";
import { Empty } from "../components/common";
import { NoiseMeter } from "../components/Gauges";
import { useSous } from "../hooks/useSous";
import type { VoiceState } from "../hooks/useVoice";
import type { Action, ActionType, Sense } from "../types";

// --- action meta -------------------------------------------------------------

const ACTION_ICON: Record<Exclude<ActionType, "speak">, typeof Tag> = {
  menu_hide: EyeOff,
  substitute: Shuffle,
  reorder_draft: ClipboardList,
  ask_human: Hand,
  menu_discount: Tag,
  fire_now: Flame,
  menu_restore: RotateCcw,
};

/** Best-effort guess at which sense triggered an action, from its payload / summary. */
function triggeredBy(a: Action): Exclude<Sense, "agent"> | null {
  const p = a.payload ?? {};
  if ("ingredient" in p) return "orders";
  const text = `${a.summary} ${JSON.stringify(p)}`.toLowerCase();
  if ("station" in p || /\b(nose|smell|spoil|burn|voc|walk-in|fryer oil)\b/.test(text)) return "smell";
  if ("order_id" in p) return "hearing";
  return null;
}

const SENSE_CHIP: Record<Exclude<Sense, "agent">, { label: string; className: string }> = {
  hearing: { label: "ears", className: "bg-sky-500/15 text-sky-300 border-sky-500/40" },
  smell: { label: "nose", className: "bg-violet-500/15 text-violet-300 border-violet-500/40" },
  orders: { label: "orders", className: "bg-accent/15 text-accent-soft border-accent/40" },
};

// --- small pieces ------------------------------------------------------------

function Sparkline({ points }: { points: { t: number; ratio: number }[] }) {
  const pts = points.slice(-60);
  if (pts.length < 2) return <div className="h-12 w-full rounded bg-ink-800/60" />;
  const w = 240;
  const h = 48;
  const min = Math.min(...pts.map((p) => p.ratio));
  const max = Math.max(...pts.map((p) => p.ratio));
  const span = max - min || 1;
  const d = pts.map((p, i) => `${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 4 - ((p.ratio - min) / span) * (h - 8)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-12" preserveAspectRatio="none">
      <polyline points={d} fill="none" stroke="#ff9a4d" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function SenseCard({ icon: Icon, name, status, tone, children, badge }: { icon: typeof Ear; name: string; status: string; tone: "ok" | "warn" | "bad" | "muted"; children: React.ReactNode; badge?: string }) {
  const toneCls = { ok: "text-ok", warn: "text-warn", bad: "text-bad", muted: "text-zinc-500" }[tone];
  const ring = { ok: "border-ok/30", warn: "border-warn/40", bad: "border-bad/50", muted: "border-ink-700" }[tone];
  return (
    <section className={`panel ${ring} p-5 flex flex-col gap-3 min-h-[230px]`}>
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-ink-800 ${toneCls}`}>
            <Icon size={28} />
          </span>
          <div>
            <div className="text-[11px] uppercase tracking-[0.25em] text-zinc-500">{name}</div>
            <div className={`text-2xl font-black leading-tight ${toneCls}`}>{status}</div>
          </div>
        </div>
        {badge && <span className="pill bg-ink-800 text-zinc-400 border border-ink-600">{badge}</span>}
      </header>
      <div className="flex-1 flex flex-col justify-end gap-2">{children}</div>
    </section>
  );
}

// --- view --------------------------------------------------------------------

export function Live({ voice }: { voice: VoiceState }) {
  const { state, actions } = useSous();
  if (!state) return <Empty>Waiting for Sous…</Empty>;

  const hearing = state.senses.hearing;
  const smell = state.senses.smell;
  const latestHear = hearing.recent[0];

  const open = state.orders.filter((o) => o.status !== "picked_up").length;
  const nextOut = state.inventory
    .filter((i) => i.minutes_to_stockout !== null)
    .sort((a, b) => (a.minutes_to_stockout ?? Infinity) - (b.minutes_to_stockout ?? Infinity))[0];
  const nextOutSoon = nextOut && (nextOut.minutes_to_stockout ?? Infinity) <= 60;

  const line = voice.current ?? state.voice.last_line;
  const glowing = voice.speaking && !voice.muted;

  const recent = (actions.length ? actions : state.actions).filter((a) => a.type !== "speak").slice(0, 3);

  const liveItems = state.menu.filter((m) => m.available).length;
  const pulled = state.menu.length - liveItems;

  const smellStatus = smell.status === "anomaly" && smell.anomaly ? smell.anomaly.kind.replace("_", " ") : smell.status;
  const smellTone = smell.status === "anomaly" ? "bad" : smell.status === "nominal" ? "ok" : smell.status === "warming" ? "warn" : "muted";

  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <div className="max-w-6xl mx-auto flex flex-col gap-6">
        <p className="text-center text-sm text-zinc-500">
          SOUS listens, smells and reads the order stream, then speaks to the line and fixes the storefront before a customer notices.
        </p>

        <div className="grid grid-cols-3 gap-5">
          <SenseCard icon={Ear} name="Ears" status={hearing.active ? "Listening" : "Inactive"} tone={hearing.active ? "ok" : "muted"} badge={hearing.active ? hearing.source : undefined}>
            {latestHear ? (
              <div>
                <div className="text-xl font-bold leading-tight">{latestHear.label}</div>
                <div className="text-sm text-zinc-400 line-clamp-2">{latestHear.detail}</div>
              </div>
            ) : (
              <div className="text-sm text-zinc-500">{hearing.active ? "Nothing notable yet." : "Play the soundtrack or start the mic to hear the room."}</div>
            )}
            <NoiseMeter db={hearing.noise_db} active={hearing.active} />
          </SenseCard>

          <SenseCard icon={Wind} name="Nose" status={smellStatus} tone={smellTone} badge={`device · ${smell.device}`}>
            <div className="text-sm text-zinc-400">{smell.location}</div>
            <div className="flex items-baseline gap-2">
              <span className="num text-5xl font-black leading-none">{smell.ratio === null ? "—" : smell.ratio.toFixed(2)}</span>
              <span className="text-sm text-zinc-400">× clean air</span>
            </div>
            <Sparkline points={smell.trace} />
          </SenseCard>

          <SenseCard icon={ReceiptText} name="Orders" status={`${open} open ticket${open === 1 ? "" : "s"}`} tone={open > 6 ? "warn" : "ok"} badge={state.rush ? "rush" : undefined}>
            <div className="text-[11px] uppercase tracking-widest text-zinc-500">Next stockout</div>
            {nextOutSoon && nextOut ? (
              <div className={`text-2xl font-bold leading-tight ${(nextOut.minutes_to_stockout ?? 99) <= 10 ? "text-bad" : "text-warn"}`}>
                <span className="capitalize">{nextOut.label ?? nextOut.name}</span> in <span className="num">{Math.round(nextOut.minutes_to_stockout ?? 0)}</span> min
              </div>
            ) : (
              <div className="text-2xl font-bold leading-tight text-zinc-300">none within an hour</div>
            )}
          </SenseCard>
        </div>

        <section className={`panel p-8 text-center transition-colors ${glowing ? "border-accent/50" : ""}`}>
          <div className="flex items-center justify-center gap-3 mb-3">
            <span className={`inline-flex items-center justify-center w-11 h-11 rounded-full ${voice.muted ? "bg-ink-700 text-zinc-500" : "bg-accent/20 text-accent-soft"} ${glowing ? "animate-speakGlow" : ""}`}>
              {voice.muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </span>
            <span className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">Sous says{voice.muted ? " · muted" : ""}</span>
          </div>
          <p className={`text-3xl lg:text-4xl font-semibold leading-snug max-w-4xl mx-auto ${line ? "text-zinc-50" : "text-zinc-500 italic"}`}>{line || "Quiet for now — the line is on pace."}</p>
        </section>

        <section>
          <div className="text-[11px] uppercase tracking-[0.25em] text-zinc-500 mb-2">What Sous just did</div>
          {recent.length === 0 ? (
            <div className="panel p-4 text-sm text-zinc-500">No actions yet — turn on Rush or run the demo.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {recent.map((a) => {
                const Icon = ACTION_ICON[a.type as Exclude<ActionType, "speak">] ?? Tag;
                const by = triggeredBy(a);
                return (
                  <div key={a.id} className="panel px-4 py-3 flex items-center gap-4 animate-slideIn">
                    <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-ink-800 text-accent-soft shrink-0">
                      <Icon size={20} />
                    </span>
                    <span className="text-lg font-semibold flex-1 truncate">{a.summary}</span>
                    {by && <span className={`pill border ${SENSE_CHIP[by].className}`}>{SENSE_CHIP[by].label}</span>}
                    {a.by === "llm" && <span className="pill bg-ink-800 text-zinc-400 border border-ink-600">llm</span>}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <a href="#/storefront" className="flex items-center justify-center gap-2 text-sm text-zinc-400 hover:text-zinc-100 border-t border-ink-700 pt-4 transition-colors">
          <Store size={14} />
          Storefront: <span className="num text-zinc-200">{liveItems}</span> of <span className="num text-zinc-200">{state.menu.length}</span> items live
          {pulled > 0 && (
            <>
              {" · "}
              <span className="text-bad">{pulled} pulled by Sous</span>
            </>
          )}
        </a>
      </div>
    </div>
  );
}
