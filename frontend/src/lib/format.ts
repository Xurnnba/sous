import type { Channel, LateRisk, Sense } from "../types";

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
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function simClock(simMinutes: number): string {
  // Kitchen opens at 11:00 in sim time.
  const total = 11 * 60 + simMinutes;
  const h = Math.floor(total / 60) % 24;
  const m = Math.floor(total % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export const channelMeta: Record<Channel, { label: string; className: string }> = {
  doordash: { label: "DoorDash", className: "bg-doordash text-white" },
  ubereats: { label: "Uber Eats", className: "bg-ubereats text-black" },
  phone: { label: "Phone", className: "bg-sky-500 text-black" },
  walkin: { label: "Walk-in", className: "bg-zinc-300 text-black" },
};

export const riskColor: Record<LateRisk, string> = {
  low: "text-ok",
  med: "text-warn",
  high: "text-bad",
};

export const riskBorder: Record<LateRisk, string> = {
  low: "border-l-ok",
  med: "border-l-warn",
  high: "border-l-bad",
};

export const senseLabel: Record<Sense, string> = {
  hearing: "Ears",
  smell: "Nose",
  orders: "Orders",
  agent: "Brain",
};

export function minutesToStockoutColor(m: number | null): string {
  if (m === null) return "text-zinc-400";
  if (m <= 10) return "text-bad";
  if (m <= 30) return "text-warn";
  return "text-ok";
}

export const freshnessClass: Record<string, string> = {
  fresh: "bg-ok/15 text-ok border-ok/40",
  watch: "bg-warn/15 text-warn border-warn/40",
  turning: "bg-accent/15 text-accent-soft border-accent/40",
  spoiled: "bg-bad/15 text-bad border-bad/40",
};

export const scenarioLabels: { name: "spoilage_walkin" | "fryer_oil" | "burning" | "cleaning" | "nominal" | "stop"; label: string }[] = [
  { name: "spoilage_walkin", label: "Spoilage in walk-in" },
  { name: "fryer_oil", label: "Fryer oil degraded" },
  { name: "burning", label: "Burning at station" },
  { name: "cleaning", label: "Cleaning cycle" },
  { name: "nominal", label: "Nominal" },
  { name: "stop", label: "Stop" },
];
