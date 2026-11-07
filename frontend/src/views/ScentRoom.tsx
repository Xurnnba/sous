import { Eraser, Hand, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Empty, Panel, UrgencyPill } from "../components/common";
import { useSous } from "../hooks/useSous";
import { clockTime, freshnessClass, pct, smellKindLabel, titleCase } from "../lib/format";
import type { RoomLayout, RoomNose, RoomPaletteEntry, RoomSource, RoomState, RoomZone } from "../types";

const W = 100;
const H = 60;
const HAZE_R = 14;
const DRAG_THRESHOLD_PX = 6;
const OPTIMISTIC_MS = 3000;

const KIND_EMOJI: Record<string, string> = {
  spoiled_produce: "🥬",
  spoiling_protein: "🍗",
  burnt_pan: "🍳",
  old_fry_oil: "🛢️",
  cleaner_spray: "🧴",
  fresh_produce: "🥑",
  fresh_protein: "🥩",
};
const emojiFor = (kind: string) => KIND_EMOJI[kind] ?? "💨";

const ZONE_FILL: Record<RoomZone["kind"], { fill: string; opacity: number }> = {
  cold: { fill: "#7aa7c7", opacity: 0.07 },
  dry: { fill: "#a1a1aa", opacity: 0.04 },
  hot: { fill: "#d9894f", opacity: 0.05 },
  prep: { fill: "#a1a1aa", opacity: 0.025 },
  front: { fill: "#a1a1aa", opacity: 0.015 },
};

const FRESH_COLOR: Record<string, string> = { fresh: "#5fb58a", watch: "#d6a548", turning: "#d9894f", spoiled: "#e06c66" };
const URGENCY_COLOR: Record<string, string> = { now: "#e06c66", next: "#d6a548", today: "#d9894f", info: "#a1a1aa" };

const BIN_EMOJI: Record<string, string> = {
  avocado: "🥑", tomato: "🍅", cheese: "🧀", eggs: "🥚", chicken: "🍗", carnitas: "🥩",
  tortilla: "🫓", sourdough: "🍞", potatoes: "🥔", salsa_verde: "🫙", horchata: "🥛",
};

/* ---------------------------------------------------------------- label placement
 * Labels are sized in screen pixels (converted to plan units with the live px-per-unit), then placed
 * greedily: each label tries a few positions around its anchor and takes the first one that stays
 * inside its zone and clears every marker and label already placed. A label that fits nowhere is
 * dropped (its marker still has a hover title, and the panels below list everything by name). */
type Box = { x0: number; y0: number; x1: number; y1: number };
type PlacedLabel = { key: string; text: string; x: number; y: number; anchor: "start" | "middle" | "end"; fs: number; fill: string; weight?: number };
type Side = "right" | "below" | "left" | "above";
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (a: Box, b: Box) => a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;
const textWidth = (t: string, fs: number) => t.length * fs * 0.58 + fs * 0.2;
const zoneBox = (z: { x: number; y: number; w: number; h: number }, inset: number): Box => ({ x0: z.x + inset, y0: z.y + inset, x1: z.x + z.w - inset, y1: z.y + z.h - inset });

function tryPlace(
  key: string, text: string, fs: number, fill: string, ax: number, ay: number, r: number,
  bounds: Box, taken: Box[], sides: Side[], weight?: number,
): PlacedLabel | null {
  const w = textWidth(text, fs);
  const h = fs * 1.15;
  const gap = fs * 0.35;
  for (const side of sides) {
    let box: Box;
    if (side === "right") box = { x0: ax + r + gap, y0: ay - h / 2, x1: ax + r + gap + w, y1: ay + h / 2 };
    else if (side === "left") box = { x0: ax - r - gap - w, y0: ay - h / 2, x1: ax - r - gap, y1: ay + h / 2 };
    else if (side === "below") box = { x0: ax - w / 2, y0: ay + r + gap * 0.5, x1: ax + w / 2, y1: ay + r + gap * 0.5 + h };
    else box = { x0: ax - w / 2, y0: ay - r - gap * 0.5 - h, x1: ax + w / 2, y1: ay - r - gap * 0.5 };
    if (!inside(box, bounds) || taken.some((t) => overlaps(box, t))) continue;
    taken.push(box);
    return { key, text, fs, fill, weight, x: box.x0 + fs * 0.1, y: box.y0 + h * 0.78, anchor: "start" };
  }
  return null;
}

/** A zone's name in the first free corner of the zone (bottom-right first: bins tend to hug the top-left). */
function placeZoneLabel(key: string, text: string, fs: number, z: Box, taken: Box[]): PlacedLabel | null {
  const w = textWidth(text, fs);
  const h = fs * 1.15;
  const corners: Box[] = [
    { x0: z.x1 - w, y0: z.y1 - h, x1: z.x1, y1: z.y1 },
    { x0: z.x0, y0: z.y1 - h, x1: z.x0 + w, y1: z.y1 },
    { x0: z.x1 - w, y0: z.y0, x1: z.x1, y1: z.y0 + h },
    { x0: z.x0, y0: z.y0, x1: z.x0 + w, y1: z.y0 + h },
  ];
  for (const box of corners) {
    if (taken.some((t) => overlaps(box, t))) continue;
    taken.push(box);
    return { key, text, fs, fill: "#71717a", x: box.x0 + fs * 0.1, y: box.y0 + h * 0.78, anchor: "start" };
  }
  return null;
}

function noseColor(n: RoomNose): string {
  if (n.status === "anomaly") return URGENCY_COLOR[n.anomaly?.urgency ?? "next"] ?? "#d6a548";
  if (n.status === "nominal") return "#5fb58a";
  return "#71717a";
}

function noseShortLabel(n: RoomNose): string {
  if (n.status === "calibrating") return "calibrating";
  if (n.status === "anomaly" && n.anomaly) return n.anomaly.label || smellKindLabel[n.anomaly.kind] || titleCase(n.anomaly.kind);
  if (n.prediction) return smellKindLabel[n.prediction.label] ?? titleCase(n.prediction.label);
  return n.status;
}

function fmtT(t: string | number): string {
  if (typeof t === "number") {
    if (t > 1e12) return clockTime(new Date(t).toISOString());
    if (t > 1e9) return clockTime(new Date(t * 1000).toISOString());
    return `${Math.round(t)} s`;
  }
  return clockTime(t);
}

const clampX = (x: number) => Math.max(1, Math.min(W - 1, x));
const clampY = (y: number) => Math.max(1, Math.min(H - 1, y));

type PaletteDrag = { kind: string; pointerId: number; startX: number; startY: number; x: number; y: number; moved: boolean };
type SourceDrag = { id: string; pointerId: number; startX: number; startY: number; x: number; y: number; moved: boolean };

/**
 * Scent room: a 2D floor plan with virtual noses. Drag scent sources from the palette onto the
 * plan; each nose runs the real classifier on the simulated air at its position.
 */
export function ScentRoom({ phone = false }: { phone?: boolean }) {
  const { state, api, mock } = useSous();
  const [layout, setLayout] = useState<RoomLayout | null>(null);
  const [palette, setPalette] = useState<RoomPaletteEntry[]>([]);
  const [polled, setPolled] = useState<RoomState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [paletteDrag, setPaletteDrag] = useState<PaletteDrag | null>(null);
  const [sourceDrag, setSourceDrag] = useState<SourceDrag | null>(null);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number; at: number }>>({});
  const [hidden, setHidden] = useState<Record<string, number>>({});
  const [added, setAdded] = useState<{ src: RoomSource; at: number }[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [ppu, setPpu] = useState(8); // rendered screen px per plan unit; drives label sizes
  const observeSvg = useCallback((el: SVGSVGElement | null) => {
    svgRef.current = el;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => el.clientWidth > 0 && setPpu(el.clientWidth / W));
    ro.observe(el);
    if (el.clientWidth > 0) setPpu(el.clientWidth / W);
  }, []);
  const toastTimer = useRef<number | null>(null);

  const say = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  // Layout + palette once (retry until the backend answers).
  useEffect(() => {
    if (mock) return;
    let alive = true;
    let timer: number | null = null;
    const load = () => {
      api
        .room()
        .then((r) => {
          if (!alive) return;
          setLayout(r.layout);
          setPalette(r.palette ?? []);
          setPolled(r.state ?? null);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setLoadError(err instanceof Error ? err.message : String(err));
          timer = window.setTimeout(load, 3000);
        });
    };
    load();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [api, mock]);

  // Live state rides the websocket snapshot; poll GET /api/room only when it does not.
  const wsRoom = state?.room ?? null;
  useEffect(() => {
    if (mock || !layout || wsRoom) return;
    const id = window.setInterval(() => {
      api
        .room()
        .then((r) => setPolled(r.state ?? null))
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(id);
  }, [api, mock, layout, wsRoom]);

  // Expire optimistic overlays.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  const room: RoomState | null = wsRoom ?? polled;

  const sources: RoomSource[] = useMemo(() => {
    const live = room?.sources ?? [];
    const liveIds = new Set(live.map((s) => s.id));
    const extra = added.filter((a) => !liveIds.has(a.src.id) && now - a.at < OPTIMISTIC_MS).map((a) => a.src);
    return [...live, ...extra]
      .filter((s) => !(hidden[s.id] && now - hidden[s.id] < OPTIMISTIC_MS))
      .map((s) => {
        if (sourceDrag?.id === s.id && sourceDrag.moved) return { ...s, x: sourceDrag.x, y: sourceDrag.y };
        const m = moved[s.id];
        if (m && now - m.at < OPTIMISTIC_MS && (Math.abs(m.x - s.x) > 0.3 || Math.abs(m.y - s.y) > 0.3)) return { ...s, x: m.x, y: m.y };
        return s;
      });
  }, [room, added, hidden, moved, sourceDrag, now]);

  const toSvg = useCallback((clientX: number, clientY: number): { x: number; y: number; inside: boolean } | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    const inside = p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
    return { x: clampX(p.x), y: clampY(p.y), inside };
  }, []);

  const addSource = useCallback(
    async (kind: string, x: number, y: number) => {
      try {
        const src = await api.roomAdd(kind, Number(x.toFixed(2)), Number(y.toFixed(2)));
        if (src && typeof src.id === "string") setAdded((a) => [...a.filter((e) => Date.now() - e.at < OPTIMISTIC_MS), { src, at: Date.now() }]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        say(/400/.test(msg) ? "Could not place that (the room holds at most 12 sources)." : `Could not place: ${msg}`);
      }
    },
    [api, say],
  );

  const removeSource = useCallback(
    async (id: string) => {
      setHidden((h) => ({ ...h, [id]: Date.now() }));
      try {
        await api.roomRemove(id);
      } catch (err) {
        setHidden((h) => {
          const { [id]: _drop, ...rest } = h;
          return rest;
        });
        say(`Could not remove: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [api, say],
  );

  const resetRoom = useCallback(async () => {
    const ids = sources.map((s) => s.id);
    setHidden((h) => ({ ...h, ...Object.fromEntries(ids.map((id) => [id, Date.now()])) }));
    setArmed(null);
    try {
      await api.roomReset();
    } catch (err) {
      say(`Could not clear: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [api, say, sources]);

  // --- palette drag (or tap to arm) -------------------------------------------------
  const onChipDown = (kind: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setPaletteDrag({ kind, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false });
  };
  const onChipMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    setPaletteDrag((d) => {
      if (!d || d.pointerId !== e.pointerId) return d;
      const movedNow = d.moved || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_THRESHOLD_PX;
      return { ...d, x: e.clientX, y: e.clientY, moved: movedNow };
    });
  };
  const onChipUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = paletteDrag;
    setPaletteDrag(null);
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.moved) {
      setArmed((a) => (a === d.kind ? null : d.kind));
      return;
    }
    const p = toSvg(e.clientX, e.clientY);
    if (p?.inside) {
      setArmed(null);
      void addSource(d.kind, p.x, p.y);
    }
  };
  const onChipCancel = () => setPaletteDrag(null);

  // --- tap-to-place fallback --------------------------------------------------------
  // Mobile browsers "touch-adjust" a tap's click toward the nearest clickable shape (a placed source's
  // grab area), so the click's coordinates can be several units off. Place at the raw pointerup instead.
  const lastUp = useRef<{ x: number; y: number; t: number } | null>(null);
  const onMapPointerUpCapture = (e: ReactPointerEvent<SVGSVGElement>) => {
    lastUp.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onMapClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (!armed) return;
    const up = lastUp.current && Date.now() - lastUp.current.t < 800 ? lastUp.current : null;
    const p = toSvg(up ? up.x : e.clientX, up ? up.y : e.clientY);
    if (!p?.inside) return;
    void addSource(armed, p.x, p.y);
    setArmed(null);
  };

  // --- moving a placed source ------------------------------------------------------
  const onSourceDown = (s: RoomSource) => (e: ReactPointerEvent<SVGGElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSourceDrag({ id: s.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: s.x, y: s.y, moved: false });
  };
  const onSourceMove = (e: ReactPointerEvent<SVGGElement>) => {
    const d = sourceDrag;
    if (!d || d.pointerId !== e.pointerId) return;
    const movedNow = d.moved || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_THRESHOLD_PX;
    if (!movedNow) return;
    const p = toSvg(e.clientX, e.clientY);
    if (p) setSourceDrag({ ...d, x: p.x, y: p.y, moved: true });
  };
  const onSourceUp = (e: ReactPointerEvent<SVGGElement>) => {
    const d = sourceDrag;
    setSourceDrag(null);
    if (!d || d.pointerId !== e.pointerId || !d.moved) return;
    const x = Number(d.x.toFixed(2));
    const y = Number(d.y.toFixed(2));
    setMoved((m) => ({ ...m, [d.id]: { x, y, at: Date.now() } }));
    api.roomMove(d.id, x, y).catch((err: unknown) => {
      setMoved((m) => {
        const { [d.id]: _drop, ...rest } = m;
        return rest;
      });
      say(`Could not move: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // --- render ----------------------------------------------------------------------
  if (mock) {
    return (
      <Shell phone={phone}>
        <Empty>The scent room needs the backend: it runs the real nose pipeline. Remove ?mock=1 to use it.</Empty>
      </Shell>
    );
  }
  if (!layout) {
    return (
      <Shell phone={phone}>
        <Empty>{loadError ? `Waiting for the server (${loadError}) — retrying…` : "Loading the floor plan…"}</Empty>
      </Shell>
    );
  }

  const k = phone ? 1.35 : 1; // marker / text scale so touch targets and labels survive a 390 px screen
  const invByName = new Map((room?.inventory ?? []).map((i) => [i.name, i]));
  const kindLabel = new Map(palette.map((p) => [p.kind, p]));
  const latestInference = room?.inferences?.[0];
  const good = palette.filter((p) => p.good);
  const bad = palette.filter((p) => !p.good);

  const roomy = ppu >= 6.5; // enough pixels per unit for text labels on bins (desktop / projector)
  const markerSize = Math.max(2.4, Math.min(4.4, 18 / ppu));
  const noseR = Math.max(1.4, Math.min(2.6, 9 / ppu));
  const labelFs = 11.5 / ppu;
  const noseList = room?.noses ?? layout.noses.map((n) => ({ ...n, status: "calibrating" as const, deviation: 0, ratios: [], prediction: null, anomaly: null, air: {} }) as RoomNose);
  // plain computation (not a hook): this runs after the component's early returns
  const labels = ((): PlacedLabel[] => {
    const out: PlacedLabel[] = [];
    const taken: Box[] = [];
    const zonesById = new Map(layout.zones.map((z) => [z.id, z]));
    const noseZone = new Map(layout.noses.map((n) => [n.id, n.zone]));
    const pad = markerSize * 0.12;
    for (const b of layout.bins) taken.push({ x0: b.x - markerSize / 2 - pad, y0: b.y - markerSize / 2 - pad, x1: b.x + markerSize / 2 + pad, y1: b.y + markerSize / 2 + pad });
    for (const n of layout.noses) taken.push({ x0: n.x - noseR * 1.15, y0: n.y - noseR * 1.15, x1: n.x + noseR * 1.15, y1: n.y + noseR * 1.15 });
    // zone names first, so markers' labels route around them
    for (const z of layout.zones) {
      const text = roomy ? z.label : z.label.split(/[\s·]/)[0];
      const l = placeZoneLabel(`zone-${z.id}`, text, Math.max(labelFs * 0.95, 9 / ppu), zoneBox(z, 0.6), taken);
      if (l) out.push(l);
    }
    // nose readings next: they are the live signal; on a narrow screen only an anomaly gets words
    for (const n of noseList) {
      if (!roomy && n.status !== "anomaly") continue;
      const z = zonesById.get(noseZone.get(n.id) ?? "");
      const anomaly = n.status === "anomaly";
      const l = tryPlace(`nose-${n.id}`, shortLabel(noseShortLabel(n), roomy ? 22 : 16), Math.max(labelFs, 10 / ppu), anomaly ? noseColor(n) : "#a1a1aa", n.x, n.y, noseR * 1.15 + 0.05,
        z ? zoneBox(z, 0.4) : zoneBox({ x: 0, y: 0, w: W, h: H }, 0.4), taken, ["right", "below", "left", "above"], anomaly ? 500 : 400);
      if (l) out.push(l);
    }
    // ingredient names last, only when there is room for text at all
    if (roomy) {
      for (const b of layout.bins) {
        const z = zonesById.get(b.zone);
        const l = tryPlace(`bin-${b.id}`, b.label, labelFs * 0.95, "#a1a1aa", b.x, b.y, markerSize / 2 + pad + 0.05, z ? zoneBox(z, 0.4) : zoneBox({ x: 0, y: 0, w: W, h: H }, 0.4), taken, ["right", "below", "left", "above"]);
        if (l) out.push(l);
      }
    }
    return out;
  })();

  const paletteBlock = (
    <div className="flex flex-col gap-2.5">
      <PaletteGroup title="Spoiled / hazards" entries={bad} tone="bad" armed={armed} onDown={onChipDown} onMove={onChipMove} onUp={onChipUp} onCancel={onChipCancel} phone={phone} />
      <PaletteGroup title="Good / benign" entries={good} tone="good" armed={armed} onDown={onChipDown} onMove={onChipMove} onUp={onChipUp} onCancel={onChipCancel} phone={phone} />
      <div className="flex items-center justify-between gap-2 min-h-[28px]">
        <span className="text-[11px] text-zinc-500 flex items-center gap-1.5">
          <Hand size={12} className="shrink-0" />
          {armed ? (
            <span className="text-zinc-300">Tap the plan to place {kindLabel.get(armed)?.label.toLowerCase() ?? armed}.</span>
          ) : (
            <span>Drag a chip onto the plan, or tap a chip then tap the plan.</span>
          )}
        </span>
        <button className="btn py-1 text-xs shrink-0" onClick={resetRoom} disabled={sources.length === 0}>
          <Eraser size={13} /> Clear room
        </button>
      </div>
    </div>
  );

  const map = (
    <div className="relative select-none" style={{ touchAction: "none" }}>
      <svg
        ref={observeSvg}
        viewBox={`0 0 ${W} ${H}`}
        className={`w-full h-auto block rounded-md bg-ink-950 ${armed ? "cursor-crosshair" : ""}`}
        style={{ touchAction: "none" }}
        onClick={onMapClick}
        onPointerUpCapture={onMapPointerUpCapture}
        role="img"
        aria-label="Kitchen floor plan with virtual noses"
      >
        <defs>
          <radialGradient id="haze-bad">
            <stop offset="0%" stopColor="#d9894f" stopOpacity={0.55} />
            <stop offset="55%" stopColor="#d9894f" stopOpacity={0.18} />
            <stop offset="100%" stopColor="#d9894f" stopOpacity={0} />
          </radialGradient>
          <radialGradient id="haze-good">
            <stop offset="0%" stopColor="#7aa7c7" stopOpacity={0.45} />
            <stop offset="55%" stopColor="#7aa7c7" stopOpacity={0.14} />
            <stop offset="100%" stopColor="#7aa7c7" stopOpacity={0} />
          </radialGradient>
        </defs>

        {/* zones */}
        <g pointerEvents="none">
          {layout.zones.map((z) => (
            <g key={z.id}>
              <rect x={z.x} y={z.y} width={z.w} height={z.h} fill={ZONE_FILL[z.kind]?.fill ?? "#a1a1aa"} fillOpacity={ZONE_FILL[z.kind]?.opacity ?? 0.03} stroke="#26262c" strokeWidth={0.25} />
            </g>
          ))}
          {/* closed rooms (zones with doors) get solid walls with a door gap */}
          {layout.doors.map((d) => {
            const z = layout.zones.find((zz) => zz.id === d.zone);
            if (!z) return null;
            return <path key={`${d.zone}-${d.x}-${d.y1}`} d={wallPath(z, d)} fill="none" stroke="#52525b" strokeWidth={0.7} strokeLinecap="round" />;
          })}
          <rect x={0.2} y={0.2} width={W - 0.4} height={H - 0.4} fill="none" stroke="#36363e" strokeWidth={0.4} rx={0.6} />
        </g>

        {/* plumes */}
        <g pointerEvents="none">
          {sources.map((s) => {
            const p = kindLabel.get(s.kind);
            const isGood = p ? p.good : false;
            const e = Math.max(0, Math.min(1, s.emission ?? 0));
            if (e < 0.02) return null;
            return <circle key={`haze-${s.id}`} cx={s.x} cy={s.y} r={HAZE_R} fill={`url(#haze-${isGood ? "good" : "bad"})`} opacity={0.15 + 0.6 * e} style={{ transition: "opacity 0.8s" }} />;
          })}
        </g>

        {/* bins */}
        <g pointerEvents="none">
          {layout.bins.map((b) => {
            const inv = invByName.get(b.ingredient);
            const m = markerSize;
            return (
              <g key={b.id}>
                <title>{`${b.label}${inv ? ` · ${inv.freshness}` : ""}`}</title>
                <rect x={b.x - m / 2} y={b.y - m / 2} width={m} height={m} rx={m * 0.22} fill="#1a1a1e" stroke="#36363e" strokeWidth={0.2} />
                <text x={b.x} y={b.y + m * 0.27} fontSize={m * 0.68} textAnchor="middle">
                  {BIN_EMOJI[b.ingredient] ?? "📦"}
                </text>
                {inv && <circle cx={b.x + m / 2 - m * 0.08} cy={b.y - m / 2 + m * 0.08} r={m * 0.17} fill={FRESH_COLOR[inv.freshness] ?? "#71717a"} stroke="#0a0a0b" strokeWidth={m * 0.05} />}
              </g>
            );
          })}
        </g>

        {/* estimated location of the newest inference */}
        {latestInference && Number.isFinite(latestInference.est_x) && Number.isFinite(latestInference.est_y) && (
          <g pointerEvents="none" opacity={0.7}>
            <circle cx={latestInference.est_x} cy={latestInference.est_y} r={2.6 * k} fill="none" stroke="#d6a548" strokeWidth={0.25} strokeDasharray="0.8 0.6" />
            <circle cx={latestInference.est_x} cy={latestInference.est_y} r={0.35} fill="#d6a548" />
          </g>
        )}

        {/* noses */}
        <g pointerEvents="none">
          {(room?.noses ?? layout.noses.map((n) => ({ ...n, status: "calibrating" as const, deviation: 0, ratios: [], prediction: null, anomaly: null, air: {} }))).map((n) => {
            const c = noseColor(n);
            return (
              <g key={n.id}>
                <title>{`${n.label}: ${noseShortLabel(n)}`}</title>
                {n.status === "anomaly" && <circle cx={n.x} cy={n.y} r={noseR * 1.7} fill="none" stroke={c} strokeWidth={0.2} className="animate-pulseRing" />}
                <circle cx={n.x} cy={n.y} r={noseR} fill="#121214" stroke={c} strokeWidth={Math.max(0.3, noseR * 0.26)} />
                <circle cx={n.x} cy={n.y} r={noseR * 0.32} fill={c} />
              </g>
            );
          })}
        </g>

        {/* labels (placed without overlaps; halo keeps them legible over plumes) */}
        <g pointerEvents="none">
          {labels.map((l) => (
            <text key={l.key} x={l.x} y={l.y} fontSize={l.fs} fill={l.fill} fontWeight={l.weight ?? 400} textAnchor={l.anchor} stroke="#0a0a0b" strokeWidth={l.fs * 0.3} strokeLinejoin="round" paintOrder="stroke">
              {l.text}
            </text>
          ))}
        </g>

        {/* placed sources */}
        <g>
          {sources.map((s) => {
            const p = kindLabel.get(s.kind);
            const isGood = p ? p.good : false;
            const dragging = sourceDrag?.id === s.id && sourceDrag.moved;
            const r = 2.3 * k;
            return (
              <g key={s.id} onPointerDown={onSourceDown(s)} onPointerMove={onSourceMove} onPointerUp={onSourceUp} onPointerCancel={() => setSourceDrag(null)} onClick={(e) => { if (!armed) e.stopPropagation(); }} style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}>
                <circle cx={s.x} cy={s.y} r={r * 1.8} fill="transparent" />
                <circle cx={s.x} cy={s.y} r={r} fill="#1a1a1e" stroke={isGood ? "#7aa7c7" : "#d9894f"} strokeOpacity={0.4 + 0.5 * Math.max(0, Math.min(1, s.emission ?? 0))} strokeWidth={0.35} />
                <text x={s.x} y={s.y + r * 0.42} fontSize={r * 1.15} textAnchor="middle" pointerEvents="none">
                  {emojiFor(s.kind)}
                </text>
                {!dragging && (
                  <g
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeSource(s.id);
                    }}
                    style={{ cursor: "pointer" }}
                    aria-label={`Remove ${s.label}`}
                  >
                    <circle cx={s.x + r * 0.95} cy={s.y - r * 0.95} r={1.9 * k} fill="transparent" />
                    <circle cx={s.x + r * 0.95} cy={s.y - r * 0.95} r={0.95 * k} fill="#26262c" stroke="#52525b" strokeWidth={0.15} />
                    <path
                      d={`M ${s.x + r * 0.95 - 0.4 * k} ${s.y - r * 0.95 - 0.4 * k} L ${s.x + r * 0.95 + 0.4 * k} ${s.y - r * 0.95 + 0.4 * k} M ${s.x + r * 0.95 + 0.4 * k} ${s.y - r * 0.95 - 0.4 * k} L ${s.x + r * 0.95 - 0.4 * k} ${s.y - r * 0.95 + 0.4 * k}`}
                      stroke="#d4d4d8"
                      strokeWidth={0.22}
                      strokeLinecap="round"
                    />
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {toast && <div className="absolute left-2 right-2 bottom-2 rounded-md border border-ink-700 bg-ink-900/95 px-3 py-1.5 text-xs text-zinc-300 text-center">{toast}</div>}
    </div>
  );

  const honesty = <p className="text-[11px] text-zinc-500">Air is simulated; each nose runs the real classifier on what reaches it — it never sees what you dropped.</p>;

  const panels = (
    <>
      <Panel title="Noses" right={<span className="text-[11px] text-zinc-500">{room?.noses.length ?? 0} virtual BME688</span>}>
        {!room?.noses.length ? <Empty>Waiting for the first readings…</Empty> : <ul className="flex flex-col divide-y divide-ink-800">{room.noses.map((n) => <NoseRow key={n.id} n={n} />)}</ul>}
      </Panel>
      <Panel title="What Sous inferred" right={<span className="text-[11px] text-zinc-500">newest first</span>}>
        {!room?.inferences.length ? (
          <Empty className="py-5">Nothing yet. Drop a spoiled source near a nose.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {room.inferences.map((inf, i) => (
              <li key={`${inf.t}-${inf.nose_id}-${i}`} className={`text-sm leading-snug ${i === 0 ? "text-zinc-200" : "text-zinc-400"}`}>
                <span className="num text-[11px] text-zinc-500 mr-2">{fmtT(inf.t)}</span>
                {inf.summary}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Walk-in inventory" right={<span className="text-[11px] text-zinc-500">freshness</span>}>
        {!room?.inventory.length ? (
          <Empty className="py-5">No walk-in items reported.</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {room.inventory.map((it) => (
              <li key={it.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-zinc-300 truncate">{it.label}</span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="num text-[11px] text-zinc-500">
                    {Number.isInteger(it.on_hand) ? it.on_hand : it.on_hand.toFixed(1)} {it.unit}
                  </span>
                  <span className={`pill border ${freshnessClass[it.freshness] ?? "bg-ink-800 text-zinc-400 border-ink-700"}`}>{it.freshness}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );

  const placedList = sources.length > 0 && (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-800 pl-2 pr-1 py-0.5 text-xs text-zinc-300">
          <span aria-hidden>{emojiFor(s.kind)}</span>
          {s.label}
          {s.bin && <span className="text-zinc-500">· {s.bin}</span>}
          <span className="num text-[10px] text-zinc-500">{pct(s.emission)}</span>
          <button className="ml-0.5 p-1 rounded text-zinc-500 hover:text-zinc-200" onClick={() => void removeSource(s.id)} aria-label={`Remove ${s.label}`}>
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );

  const ghost = paletteDrag?.moved && (
    <div className="fixed z-50 pointer-events-none -translate-x-1/2 -translate-y-1/2" style={{ left: paletteDrag.x, top: paletteDrag.y }}>
      <div className="flex items-center gap-1.5 rounded-full border border-ink-600 bg-ink-800/95 px-2.5 py-1 text-sm text-zinc-200 shadow-lg">
        <span aria-hidden>{emojiFor(paletteDrag.kind)}</span>
        {kindLabel.get(paletteDrag.kind)?.label ?? paletteDrag.kind}
      </div>
    </div>
  );

  if (phone) {
    return (
      <div className="min-h-full w-full max-w-[560px] mx-auto px-4 py-4 flex flex-col gap-3">
        <header className="flex items-end justify-between gap-3">
          <div>
            <div className="label">Sous · nose demo</div>
            <h1 className="text-xl font-semibold leading-tight">Scent room</h1>
          </div>
          <a href="#/board" className="text-xs text-zinc-500 hover:text-zinc-200 pb-1 whitespace-nowrap shrink-0">
            board →
          </a>
        </header>
        {honesty}
        <section className="panel p-3 flex flex-col gap-3">
          {map}
          {paletteBlock}
          {placedList}
        </section>
        {panels}
        {ghost}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-[1400px] mx-auto flex flex-col gap-4">
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="label">Nose · virtual sensors on the floor plan</div>
            <h1 className="text-2xl font-semibold leading-tight text-zinc-100">Scent room</h1>
          </div>
          {honesty}
        </header>
        <div className="grid grid-cols-[1.7fr_1fr] gap-4 items-start">
          <section className="panel p-4 flex flex-col gap-3">
            {map}
            {paletteBlock}
            {placedList}
          </section>
          <div className="flex flex-col gap-4">{panels}</div>
        </div>
      </div>
      {ghost}
    </div>
  );
}

function Shell({ phone, children }: { phone: boolean; children: ReactNode }) {
  return <div className={phone ? "min-h-full w-full max-w-[560px] mx-auto px-4 py-6 flex flex-col" : "h-full flex flex-col p-4"}>{children}</div>;
}

function shortLabel(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Border of a zone with a gap where the door is (door on the zone's left or right wall). */
function wallPath(z: RoomZone, d: { x: number; y1: number; y2: number }): string {
  const x0 = z.x;
  const x1 = z.x + z.w;
  const y0 = z.y;
  const y1 = z.y + z.h;
  if (Math.abs(d.x - x1) < 0.01) return `M ${x1} ${d.y1} L ${x1} ${y0} L ${x0} ${y0} L ${x0} ${y1} L ${x1} ${y1} L ${x1} ${d.y2}`;
  if (Math.abs(d.x - x0) < 0.01) return `M ${x0} ${d.y2} L ${x0} ${y1} L ${x1} ${y1} L ${x1} ${y0} L ${x0} ${y0} L ${x0} ${d.y1}`;
  return `M ${x0} ${y0} H ${x1} V ${y1} H ${x0} Z`;
}

function PaletteGroup({
  title,
  entries,
  tone,
  armed,
  onDown,
  onMove,
  onUp,
  onCancel,
  phone,
}: {
  title: string;
  entries: RoomPaletteEntry[];
  tone: "good" | "bad";
  armed: string | null;
  onDown: (kind: string) => (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onMove: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onUp: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onCancel: () => void;
  phone: boolean;
}) {
  if (!entries.length) return null;
  return (
    <div>
      <div className="label mb-1.5">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map((p) => {
          const on = armed === p.kind;
          const ring = on ? (tone === "bad" ? "border-accent/50 bg-accent/10 text-zinc-100" : "border-[#7aa7c7]/50 bg-[#7aa7c7]/10 text-zinc-100") : "border-ink-700 bg-ink-800 text-zinc-300 hover:bg-ink-700";
          return (
            <button
              key={p.kind}
              type="button"
              title={p.desc}
              className={`inline-flex items-center gap-1.5 rounded-full border ${phone ? "px-3 py-2 text-sm" : "px-2.5 py-1 text-xs"} font-medium transition-colors select-none ${ring}`}
              style={{ touchAction: "none" }}
              onPointerDown={onDown(p.kind)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onCancel}
            >
              <span aria-hidden>{emojiFor(p.kind)}</span>
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NoseRow({ n }: { n: RoomNose }) {
  const c = noseColor(n);
  const air = Object.entries(n.air ?? {})
    .filter(([, v]) => v > 0.02)
    .sort((a, b) => b[1] - a[1]);
  const dev = Math.max(0, n.deviation ?? 0);
  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c }} />
          <span className="text-sm text-zinc-200 truncate">{n.label}</span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          {n.status === "anomaly" && n.anomaly ? (
            <UrgencyPill urgency={n.anomaly.urgency} />
          ) : (
            <span className={`pill ${n.status === "nominal" ? "bg-ok/10 text-ok" : "bg-ink-800 text-zinc-400"}`}>{n.status}</span>
          )}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-xs">
        <span className={n.status === "anomaly" ? "text-zinc-100 font-medium" : "text-zinc-400"}>
          {n.status === "calibrating" ? "building clean-air baseline" : noseShortLabel(n)}
          {n.status !== "calibrating" && (n.anomaly || n.prediction) && <span className="num text-zinc-500 ml-1.5">{pct(n.anomaly?.confidence ?? n.prediction?.confidence)}</span>}
        </span>
        <span className="flex items-center gap-1.5 shrink-0" title="deviation from the clean-air baseline">
          <span className="label">dev</span>
          <span className="w-16 h-1 rounded-full bg-ink-800 overflow-hidden">
            <span className="block h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(100, dev * 100)}%`, background: c }} />
          </span>
          <span className="num text-[11px] text-zinc-500 w-8 text-right">{dev.toFixed(2)}</span>
        </span>
      </div>
      <div className="mt-1 text-[11px] text-zinc-500">
        simulated air:{" "}
        {air.length === 0 ? (
          <span>clean</span>
        ) : (
          air.map(([g, v], i) => (
            <span key={g}>
              {i > 0 && " · "}
              {smellKindLabel[g] ?? titleCase(g)} <span className="num">{v.toFixed(2)}</span>
            </span>
          ))
        )}
      </div>
    </li>
  );
}
