import type { Channel, HearingInjectKind, LateRisk, Sense, SmellScenario, Urgency } from "../types";

export const money = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const money2 = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/** mm:ss from a (possibly negative) number of minutes. */
export function countdown(minutes: number): string {
  const neg = minutes < 0;
  const total = Math.round(Math.abs(minutes) * 60);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${neg ? "-" : ""}${m}:${s.toString().padStart(2, "0")}`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  // The backend sometimes sends a bare wall-clock string ("19:36:50"); show it as is.
  if (Number.isNaN(d.getTime())) return /^\d{1,2}:\d{2}/.test(iso) ? iso : "";
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** "12 s ago" / "3 min ago" / "2 h ago" relative to `now` (ms). */
export function ago(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export function simClock(simMinutes: number): string {
  // Kitchen opens at 11:00 in sim time.
  const total = 11 * 60 + simMinutes;
  const h = Math.floor(total / 60) % 24;
  const m = Math.floor(total % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export const pct = (v: number | null | undefined, digits = 0): string => (typeof v === "number" ? `${(v * 100).toFixed(digits)}%` : "—");

export const titleCase = (s: string): string => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const channelMeta: Record<Channel, { label: string; className: string }> = {
  doordash: { label: "DoorDash", className: "bg-doordash/10 text-doordash" },
  ubereats: { label: "Uber Eats", className: "bg-ubereats/10 text-ubereats" },
  phone: { label: "Phone", className: "bg-sky-400/10 text-sky-300" },
  walkin: { label: "Walk-in", className: "bg-zinc-500/15 text-zinc-300" },
};

export const riskColor: Record<LateRisk, string> = { low: "text-ok", med: "text-warn", high: "text-bad" };
export const riskBorder: Record<LateRisk, string> = { low: "border-l-ok", med: "border-l-warn", high: "border-l-bad" };

export const senseLabel: Record<Sense, string> = { hearing: "Ears", smell: "Nose", orders: "Orders", agent: "Brain" };

export function minutesToStockoutColor(m: number | null): string {
  if (m === null) return "text-zinc-400";
  if (m <= 10) return "text-bad";
  if (m <= 30) return "text-warn";
  return "text-ok";
}

export const freshnessClass: Record<string, string> = {
  fresh: "bg-ok/10 text-ok border-ok/25",
  watch: "bg-warn/10 text-warn border-warn/25",
  turning: "bg-accent/10 text-accent-soft border-accent/25",
  spoiled: "bg-bad/10 text-bad border-bad/25",
};

export const URGENCIES: Urgency[] = ["now", "next", "today", "later"];

export const urgencyMeta: Record<Urgency, { label: string; border: string; text: string; bg: string; dot: string; empty: string }> = {
  now: { label: "Now", border: "border-l-bad", text: "text-bad", bg: "bg-bad/10", dot: "bg-bad", empty: "Nothing right now" },
  next: { label: "Next", border: "border-l-warn", text: "text-warn", bg: "bg-warn/10", dot: "bg-warn", empty: "Nothing queued" },
  today: { label: "Today", border: "border-l-ok", text: "text-ok", bg: "bg-ok/10", dot: "bg-ok", empty: "Nothing for today" },
  later: { label: "Later", border: "border-l-zinc-500", text: "text-zinc-400", bg: "bg-zinc-500/10", dot: "bg-zinc-500", empty: "Nothing later" },
};

export const scenarioLabels: { name: SmellScenario; label: string }[] = [
  { name: "spoilage_walkin", label: "Spoilage (produce)" },
  { name: "spoilage_protein", label: "Spoilage (protein)" },
  { name: "fryer_oil", label: "Fryer oil" },
  { name: "burning", label: "Burning" },
  { name: "cleaning", label: "Cleaning" },
  { name: "door_open", label: "Door open" },
  { name: "nominal", label: "Nominal" },
  { name: "stop", label: "Stop" },
];

/** One display name per sound kind, used everywhere (matches the backend's PRETTY labels). */
export const SOUND_LABEL: Record<string, string> = {
  ticket_burst: "Ticket printer",
  fryer_alarm: "Fryer alarm",
  door_chime: "Door chime",
  phone_ring: "Phone ringing",
  clatter: "Clatter",
  noise_spike: "Noise spike",
  speech: "Voices",
  frying: "Frying",
};
export const soundLabel = (kind: string): string => SOUND_LABEL[kind] ?? titleCase(kind);

export const INJECT_KINDS: { kind: HearingInjectKind; label: string }[] = (
  ["ticket_burst", "fryer_alarm", "door_chime", "phone_ring", "clatter"] as HearingInjectKind[]
).map((kind) => ({ kind, label: SOUND_LABEL[kind] }));

/** Zero-shot kitchen-event score keys shown as bars on the Ears page, in display order. */
export const EVENT_SCORE_KEYS = ["fryer_alarm", "door_chime", "ticket_burst", "clatter", "phone_ring"] as const;

export const kindColor: Record<string, string> = {
  door_chime: "bg-sky-300/70",
  ticket_burst: "bg-accent",
  fryer_alarm: "bg-bad",
  clatter: "bg-warn",
  noise_spike: "bg-warn",
  phone_ring: "bg-emerald-300/70",
  speech: "bg-zinc-400",
  taught: "bg-violet-300/70",
};

/** Human label for smell classes / scenario kinds. */
export const smellKindLabel: Record<string, string> = {
  nominal: "Nominal",
  spoilage_produce: "Produce spoilage",
  spoilage_protein: "Protein spoilage",
  burning: "Burning",
  oil_degraded: "Fryer oil degraded",
  cleaning: "Cleaning",
  door_open: "Door open",
  unknown: "Unknown",
};

export const HEATER_STEPS_C = [200, 250, 320, 400];
