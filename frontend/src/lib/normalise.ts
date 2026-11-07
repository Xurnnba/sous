import { SOUND_LABEL } from "./format";
import type { Ears, Items, RoomState, Smell, SmellUrgency, State } from "../types";

/**
 * The backend is being rewritten to CONTRACT v2 while the v1 process may still be the one
 * answering. Fill every v2 field a v1 snapshot lacks so views can read `state.items`,
 * `state.senses.ears` and the 4-step smell fields without null-guarding everywhere.
 */

export const DEFAULT_LABELS: Ears["labels"] = ["fryer_alarm", "door_chime", "ticket_burst", "phone_ring", "clatter"].map((id) => ({ id, name: SOUND_LABEL[id] }));

export const EMPTY_ITEMS: Items = { open: [], recent_closed: [], counts: { now: 0, next: 0, today: 0, later: 0 }, total_created: 0 };

export function countItems(open: Items["open"]): Items["counts"] {
  const c = { now: 0, next: 0, today: 0, later: 0 };
  for (const it of open) c[it.urgency] += 1;
  return c;
}

type Loose = Record<string, unknown>;

function asObj(v: unknown): Loose {
  return v && typeof v === "object" ? (v as Loose) : {};
}

export function normaliseState(raw: unknown): State {
  const r = asObj(raw);
  const senses = asObj(r.senses);
  const hearing = asObj(senses.hearing);
  const smellRaw = asObj(senses.smell);
  const earsRaw = asObj(senses.ears);
  const itemsRaw = asObj(r.items);
  const providers = asObj(r.providers);

  const hearingNorm: State["senses"]["hearing"] = {
    active: Boolean(hearing.active),
    source: (hearing.source as State["senses"]["hearing"]["source"]) ?? "none",
    noise_db: typeof hearing.noise_db === "number" ? hearing.noise_db : -60,
    stress: typeof hearing.stress === "number" ? hearing.stress : 0,
    recent: Array.isArray(hearing.recent) ? (hearing.recent as State["senses"]["hearing"]["recent"]) : [],
  };

  const ears: Ears = {
    active: typeof earsRaw.active === "boolean" ? earsRaw.active : hearingNorm.active,
    model: (earsRaw.model as Ears["model"]) ?? "idle",
    mics: Array.isArray(earsRaw.mics) ? (earsRaw.mics as Ears["mics"]).map(normaliseMic) : [],
    prototypes: Array.isArray(earsRaw.prototypes) ? (earsRaw.prototypes as Ears["prototypes"]) : [],
    labels: Array.isArray(earsRaw.labels) && earsRaw.labels.length ? (earsRaw.labels as Ears["labels"]) : DEFAULT_LABELS,
  };

  const smell = normaliseSmell(smellRaw);

  const open = Array.isArray(itemsRaw.open) ? (itemsRaw.open as Items["open"]) : [];
  const items: Items = {
    open,
    recent_closed: Array.isArray(itemsRaw.recent_closed) ? (itemsRaw.recent_closed as Items["recent_closed"]) : [],
    counts: itemsRaw.counts ? (itemsRaw.counts as Items["counts"]) : countItems(open),
    total_created: typeof itemsRaw.total_created === "number" ? itemsRaw.total_created : open.length,
  };

  const metrics = asObj(r.metrics);
  const voice = asObj(r.voice);

  return {
    clock: typeof r.clock === "string" ? r.clock : new Date().toISOString(),
    sim_minutes: typeof r.sim_minutes === "number" ? r.sim_minutes : 0,
    rush: Boolean(r.rush),
    speed: typeof r.speed === "number" ? r.speed : 1,
    orders: Array.isArray(r.orders) ? (r.orders as State["orders"]) : [],
    inventory: Array.isArray(r.inventory) ? (r.inventory as State["inventory"]) : [],
    menu: Array.isArray(r.menu) ? (r.menu as State["menu"]) : [],
    metrics: {
      orders_served: Number(metrics.orders_served ?? 0),
      stockouts_prevented: Number(metrics.stockouts_prevented ?? 0),
      est_refunds_avoided_usd: Number(metrics.est_refunds_avoided_usd ?? 0),
      est_waste_saved_usd: Number(metrics.est_waste_saved_usd ?? 0),
    },
    senses: { hearing: hearingNorm, ears, smell },
    items,
    voice: { last_line: typeof voice.last_line === "string" ? voice.last_line : "", muted: Boolean(voice.muted) },
    actions: Array.isArray(r.actions) ? (r.actions as State["actions"]) : [],
    providers: {
      llm: (providers.llm as State["providers"]["llm"]) ?? "rules",
      tts: (providers.tts as State["providers"]["tts"]) ?? "none",
      ears: (providers.ears as State["providers"]["ears"]) ?? (ears.mics.length ? "ready" : "unloaded"),
      nose: typeof providers.nose === "string" ? providers.nose : smell.device,
    },
    room: normaliseRoom(r.room),
  };
}

/** Scent room state; null when the snapshot has none (older backend or mock). */
export function normaliseRoom(raw: unknown): RoomState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Loose;
  return {
    sources: Array.isArray(r.sources) ? (r.sources as RoomState["sources"]) : [],
    noses: Array.isArray(r.noses) ? (r.noses as RoomState["noses"]) : [],
    inferences: Array.isArray(r.inferences) ? (r.inferences as RoomState["inferences"]) : [],
    inventory: Array.isArray(r.inventory) ? (r.inventory as RoomState["inventory"]) : [],
  };
}

function normaliseMic(m: Loose): Ears["mics"][number] {
  return {
    mic: String(m.mic ?? "mic"),
    location: String(m.location ?? "kitchen"),
    source: (m.source as "mic" | "soundtrack") ?? "mic",
    model: (m.model as Ears["mics"][number]["model"]) ?? "loading",
    level_db: typeof m.level_db === "number" ? m.level_db : -60,
    floor_db: typeof m.floor_db === "number" ? m.floor_db : -50,
    active: Boolean(m.active),
    speech_fraction: typeof m.speech_fraction === "number" ? m.speech_fraction : 0,
    scores: asObj(m.scores) as Record<string, number>,
    top: Array.isArray(m.top) ? (m.top as [string, number][]) : [],
    taught: asObj(m.taught) as Record<string, number>,
    teaching: m.teaching ? (m.teaching as Ears["mics"][number]["teaching"]) : null,
    windows: typeof m.windows === "number" ? m.windows : 0,
  };
}

function normaliseSmell(s: Loose): Smell {
  const legacyRatio = typeof s.ratio === "number" ? s.ratio : null;
  const ratios = Array.isArray(s.ratios) ? (s.ratios as number[]) : legacyRatio !== null ? [legacyRatio, legacyRatio, legacyRatio, legacyRatio] : null;
  const cal = asObj(s.calibration);
  const legacyBaseline = typeof s.baseline_ohm === "number" ? s.baseline_ohm : null;
  const model = asObj(s.model);
  const anomalyRaw = s.anomaly ? asObj(s.anomaly) : null;
  const anomaly: Smell["anomaly"] = anomalyRaw
    ? {
        kind: String(anomalyRaw.kind ?? "unknown"),
        confidence: typeof anomalyRaw.confidence === "number" ? anomalyRaw.confidence : Math.min(1, Number(anomalyRaw.magnitude ?? 0.5)),
        urgency: (anomalyRaw.urgency as SmellUrgency) ?? "next",
        since: String(anomalyRaw.since ?? new Date().toISOString()),
      }
    : null;
  const status = (s.status as Smell["status"]) ?? "offline";
  return {
    device: (s.device as Smell["device"]) ?? "none",
    sensor_id: String(s.sensor_id ?? "—"),
    location: String(s.location ?? "walk-in"),
    status,
    calibration: {
      status: String(cal.status ?? (legacyBaseline ? "baseline" : status === "offline" ? "offline" : "unknown")),
      quality: typeof cal.quality === "number" ? cal.quality : legacyBaseline ? 0.6 : 0,
      baseline_ohm: Array.isArray(cal.baseline_ohm) ? (cal.baseline_ohm as number[]) : legacyBaseline ? [legacyBaseline] : null,
      rh_slope: typeof cal.rh_slope === "number" ? cal.rh_slope : null,
      samples: typeof cal.samples === "number" ? cal.samples : 0,
      ...cal,
    },
    ratios,
    fingerprint: Array.isArray(s.fingerprint) ? (s.fingerprint as number[]) : null,
    probs: s.probs && typeof s.probs === "object" ? (s.probs as Record<string, number>) : null,
    anomaly,
    scenario: typeof s.scenario === "string" ? s.scenario : null,
    trace: Array.isArray(s.trace) ? (s.trace as Smell["trace"]) : [],
    model: {
      name: String(model.name ?? (Array.isArray(s.ratios) ? "gbdt-fingerprint" : "threshold (v1)")),
      features: Number(model.features ?? 0),
      trained_on: Number(model.trained_on ?? 0),
      accuracy: Number(model.accuracy ?? 0),
    },
    single_channel: typeof s.single_channel === "boolean" ? s.single_channel : !Array.isArray(s.ratios),
    baseline_ohm: legacyBaseline,
    gas_ohm: typeof s.gas_ohm === "number" ? s.gas_ohm : null,
    ratio: legacyRatio ?? (ratios ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null),
    temp_c: typeof s.temp_c === "number" ? s.temp_c : null,
    rh: typeof s.rh === "number" ? s.rh : null,
  };
}
