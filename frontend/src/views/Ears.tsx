import { Bell, DoorOpen, Mic, MicOff, Music, Pause, Phone, Printer, Smartphone, Trash2, Utensils } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Bar, Empty, Panel, Ring, ScoreBar } from "../components/common";
import { QrCode } from "../components/QrCode";
import { SoundtrackTimeline } from "../components/SoundtrackTimeline";
import type { AudioStreamState } from "../hooks/useAudioStream";
import { useSous } from "../hooks/useSous";
import type { SousApi } from "../lib/api";
import { isLoopbackHost, MIC_LOCATIONS, soundBoardUrl, soundBoardUrlOn } from "../lib/device";
import { clockTime, EVENT_SCORE_KEYS, INJECT_KINDS, kindColor, titleCase } from "../lib/format";
import type { Event, HearingInjectKind, Mic as MicT } from "../types";

const INJECT_ICON: Record<HearingInjectKind, typeof Bell> = { ticket_burst: Printer, fryer_alarm: Bell, door_chime: DoorOpen, phone_ring: Phone, clatter: Utensils };

const dbPct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

function LevelWithFloor({ level, floor }: { level: number; floor: number }) {
  const lvl = dbPct(level);
  const fl = dbPct(floor);
  return (
    <div className="relative h-3 rounded-full bg-ink-700 overflow-hidden">
      <div className={`h-full rounded-full transition-[width] duration-200 ${lvl > 85 ? "bg-bad" : lvl > 65 ? "bg-warn" : "bg-ok"}`} style={{ width: `${lvl}%` }} />
      <span className="absolute top-0 h-full w-0.5 bg-zinc-100" style={{ left: `${fl}%` }} title={`noise floor ${floor.toFixed(0)} dB`} />
    </div>
  );
}

function MicCard({ mic, isThisDevice }: { mic: MicT; isThisDevice: boolean }) {
  const modelTone = mic.model === "yamnet" ? "bg-ok/15 text-ok" : mic.model === "loading" ? "bg-warn/15 text-warn" : "bg-ink-700 text-zinc-300";
  return (
    <article className={`rounded-xl border bg-ink-800 p-4 flex flex-col gap-3 ${mic.active ? "border-ink-600" : "border-ink-700 opacity-60"}`}>
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-flex items-center justify-center w-9 h-9 rounded-xl ${mic.active ? "bg-ok/15 text-ok" : "bg-ink-700 text-zinc-500"}`}>
            <Mic size={18} />
          </span>
          <div className="min-w-0">
            <div className="text-lg font-black leading-tight capitalize truncate">
              {mic.location}
              {isThisDevice && <span className="ml-2 text-[11px] font-semibold text-accent-soft uppercase tracking-wider">this device</span>}
            </div>
            <div className="text-[11px] text-zinc-500 num truncate">
              {mic.mic} · {mic.windows} windows
            </div>
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <span className="pill bg-ink-700 text-zinc-300">{mic.source}</span>
          <span className={`pill ${modelTone}`}>{mic.model}</span>
        </div>
      </header>

      <div>
        <LevelWithFloor level={mic.level_db} floor={mic.floor_db} />
        <div className="flex justify-between text-[11px] text-zinc-400 mt-1 num">
          <span>
            level {mic.level_db.toFixed(0)} dB · floor {mic.floor_db.toFixed(0)} dB
          </span>
          <span>speech {(mic.speech_fraction * 100).toFixed(0)}%</span>
        </div>
      </div>

      {mic.teaching && (
        <div className="flex items-center gap-3 rounded-lg bg-accent/10 border border-accent/40 px-3 py-2">
          <Ring value={1 - mic.teaching.remaining_s / 4} size={40} stroke={4} color="#ff7a1a">
            <span className="num text-sm font-black">{mic.teaching.remaining_s}</span>
          </Ring>
          <div className="text-sm">
            <div className="font-bold">Teaching “{titleCase(mic.teaching.label)}”</div>
            <div className="text-xs text-zinc-400">{mic.teaching.examples} examples so far — make the sound now</div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Heard as (AudioSet)</div>
          <div className="space-y-1">
            {mic.top.length ? mic.top.slice(0, 3).map(([name, score]) => <ScoreBar key={name} label={name} value={score} color="bg-zinc-400" />) : <div className="text-xs text-zinc-500">no windows yet</div>}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Kitchen events (zero-shot)</div>
          <div className="space-y-1">
            {EVENT_SCORE_KEYS.map((k) => (
              <ScoreBar key={k} label={k.replace("_", " ")} value={mic.scores[k] ?? 0} color={kindColor[k] ?? "bg-sky-400"} highlight={(mic.scores[k] ?? 0) > 0.3} />
            ))}
          </div>
        </div>
      </div>
      {Object.keys(mic.taught).filter((k) => k !== "_background").length > 0 && (
        <div className="text-[11px] text-zinc-400 num">
          taught: {Object.entries(mic.taught).filter(([k]) => k !== "_background").map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" · ")}
        </div>
      )}
    </article>
  );
}

export function Ears({ audio }: { audio: AudioStreamState }) {
  const { state, events, api, mock } = useSous();
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [teachError, setTeachError] = useState<string | null>(null);
  const teachingRef = useRef<{ label: string; mic: string } | null>(null);
  const startedAt = useRef<number | null>(null);
  const boardUrl = useSoundBoardUrl(api);

  useEffect(() => {
    if (audio.source === "soundtrack") startedAt.current = Date.now();
  }, [audio.source]);
  const playbackFinished = audio.source !== "soundtrack" && startedAt.current !== null;

  const ears = state?.senses.ears;
  const myMic = ears?.mics.find((m) => m.mic === audio.micId) ?? null;

  // Detect the end of a teaching session (teaching -> null) and toast the example count.
  useEffect(() => {
    if (!ears) return;
    const t = teachingRef.current;
    if (!t) return;
    const mic = ears.mics.find((m) => m.mic === t.mic);
    if (mic && mic.teaching) return;
    const proto = ears.prototypes.find((p) => p.label === t.label);
    teachingRef.current = null;
    setToast(proto ? `Learned ${proto.examples} example${proto.examples === 1 ? "" : "s"} of “${proto.name}”` : `Finished teaching “${titleCase(t.label)}”`);
    const h = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(h);
  }, [ears]);

  if (!state || !ears) return <Empty>Loading the ears…</Empty>;

  const hearing = events.filter((e) => e.sense === "hearing" && e.kind !== "mic_online" && e.kind !== "mic_offline");
  const teachMic = myMic ?? ears.mics[0] ?? null;
  const background = ears.prototypes.find((p) => p.label === "_background");
  const taught = ears.prototypes.filter((p) => p.label !== "_background");

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      console.warn(key, err);
    } finally {
      setBusy(null);
    }
  };

  const teach = (label: string) => {
    if (!teachMic) {
      setTeachError("No microphone is connected — tap Listen first.");
      return;
    }
    setTeachError(null);
    teachingRef.current = { label, mic: teachMic.mic };
    void run(`teach-${label}`, () =>
      api.earTeach({ label, mic: teachMic.mic, seconds: 4 }).catch((err) => {
        teachingRef.current = null;
        setTeachError(err instanceof Error ? err.message : "Teaching failed");
      }),
    );
  };

  const teachingNow = ears.mics.find((m) => m.teaching)?.teaching ?? null;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-[1400px] mx-auto grid grid-cols-[1.25fr_1fr] gap-4 content-start">
        <header className="col-span-2 flex items-center justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Microphones · few-shot sound events</div>
            <h1 className="text-2xl font-black">Ears</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className={`pill border ${ears.active ? "bg-ok/15 text-ok border-ok/40" : "bg-ink-800 text-zinc-400 border-ink-600"}`}>{ears.active ? `${ears.mics.filter((m) => m.active).length} live` : "inactive"}</span>
            <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">model · {ears.model}</span>
            <span className="pill bg-ink-800 text-zinc-300 border border-ink-600">provider · {state.providers.ears}</span>
          </div>
        </header>

        {/* LEFT: microphones */}
        <div className="flex flex-col gap-4">
          <Panel title="Microphones" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">/ws/audio · 16 kHz Int16 · 250 ms frames</span>}>
            <div className="flex flex-col gap-3">
              {ears.mics.length === 0 && <Empty>No microphone connected. Tap Listen on this device, or open the sound board on a phone.</Empty>}
              {ears.mics.map((m) => (
                <MicCard key={m.mic} mic={m} isThisDevice={m.mic === audio.micId} />
              ))}
            </div>
          </Panel>

          <Panel title="This device" right={<span className="num text-[10px] text-zinc-500">mic id {audio.micId}</span>}>
            <div className="flex items-center gap-3 flex-wrap">
              <button className={`btn py-2.5 px-4 text-base ${audio.source === "mic" ? "btn-on" : "btn-accent"}`} onClick={() => (audio.source === "mic" ? audio.stop() : void audio.startMic())}>
                {audio.source === "mic" ? <Mic size={18} /> : <MicOff size={18} />} {audio.source === "mic" ? "Listening" : "Listen"}
              </button>
              <label className="btn cursor-pointer gap-2">
                <span className="text-xs text-zinc-400">at</span>
                <select className="bg-transparent outline-none text-sm font-semibold" value={audio.location} onChange={(e) => audio.setLocation(e.target.value as (typeof MIC_LOCATIONS)[number])}>
                  {MIC_LOCATIONS.map((l) => (
                    <option key={l} value={l} className="bg-ink-800">
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex-1 min-w-[160px]">
                <Bar value={audio.level} max={1} color={audio.level > 0.85 ? "bg-bad" : audio.level > 0.6 ? "bg-warn" : "bg-ok"} />
                <div className="text-[10px] text-zinc-500 num mt-1">{audio.source ? `${audio.source} · ${audio.framesSent} frames · ${audio.wsState}` : "no input from this device"}</div>
              </div>
            </div>
            {audio.error && <p className="text-xs text-bad mt-2">{audio.error}</p>}
            {mock && audio.source === "mic" && <p className="text-[11px] text-zinc-500 mt-2">Mock mode: frames are captured and counted but not sent anywhere.</p>}
          </Panel>
        </div>

        {/* RIGHT: teach */}
        <div className="flex flex-col gap-4">
          <Panel title="Teach Sous a sound" right={<span className="text-[10px] text-zinc-500 uppercase tracking-widest">POST /api/ear/teach · 4 s</span>}>
            <p className="text-xs text-zinc-400 mb-3">
              Press a label, then make the sound for four seconds{teachMic ? ` into the ${teachMic.location} mic (${teachMic.mic})` : ""}. Sous memorises it as a prototype and recognises it from then on — what you taught beats the zero-shot guess.
            </p>
            <div className="flex flex-wrap gap-2">
              {ears.labels.map((l) => {
                const known = taught.find((p) => p.label === l.id);
                const active = teachingNow?.label === l.id;
                return (
                  <button key={l.id} className={`btn py-2 ${active ? "btn-accent animate-firePulse" : known ? "border-violet-500/50 text-violet-200" : ""}`} disabled={!!teachingNow || busy === `teach-${l.id}`} onClick={() => teach(l.id)}>
                    {l.name}
                    {known && <span className="num text-[10px] text-zinc-400">· {known.examples}</span>}
                  </button>
                );
              })}
            </div>
            {teachingNow && (
              <div className="mt-4 flex items-center gap-4 rounded-xl bg-accent/10 border border-accent/40 px-4 py-3">
                <Ring value={1 - teachingNow.remaining_s / 4} size={64} stroke={6} color="#ff7a1a">
                  <span className="num text-xl font-black">{teachingNow.remaining_s}</span>
                </Ring>
                <div>
                  <div className="text-lg font-bold">Make the sound now</div>
                  <div className="text-sm text-zinc-400">
                    Teaching “{titleCase(teachingNow.label)}” · {teachingNow.examples} examples captured
                  </div>
                </div>
              </div>
            )}
            {toast && <div className="mt-3 rounded-lg bg-ok/15 border border-ok/40 text-ok px-3 py-2 text-sm font-semibold animate-slideIn">{toast}</div>}
            {teachError && <div className="mt-3 text-xs text-bad">{teachError}</div>}

            <div className="mt-4">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1.5">Learned sounds</div>
              {taught.length === 0 ? (
                <div className="text-xs text-zinc-500">Nothing taught yet — Sous is running on zero-shot AudioSet scores alone.</div>
              ) : (
                <ul className="divide-y divide-ink-700/70">
                  {taught.map((p) => (
                    <li key={p.label} className="flex items-center gap-3 py-1.5">
                      <span className="font-semibold flex-1">{p.name}</span>
                      <span className="num text-xs text-zinc-400">
                        {p.examples} example{p.examples === 1 ? "" : "s"}
                      </span>
                      <button className="btn py-0.5 px-2 text-xs text-zinc-400 hover:text-bad" title="Forget this sound" disabled={busy === `forget-${p.label}`} onClick={() => run(`forget-${p.label}`, () => api.earForget(p.label))}>
                        <Trash2 size={12} /> Forget
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {background && <div className="text-[11px] text-zinc-500 mt-2">room background: {background.examples}</div>}
            </div>
          </Panel>

          <Panel title="Sound board on your phone" right={<Smartphone size={14} className="text-zinc-500" />}>
            <div className="flex items-center gap-4">
              <div className="flex flex-col items-center gap-1.5 shrink-0">
                <QrCode text={boardUrl.url} size={128} />
                <a href={boardUrl.url} className="num text-[11px] text-accent-soft hover:underline break-all text-center max-w-[160px]">
                  {boardUrl.url.replace(/^https?:\/\//, "")}
                </a>
              </div>
              <div className="text-sm text-zinc-400">
                <p>Scan to open the sound board. Tap a clip on the phone; this laptop listens and the board lights up when Sous hears it.</p>
                <p className="text-[11px] text-zinc-500 mt-1.5">
                  {boardUrl.source === "lan" ? `LAN address from /api/hosts${boardUrl.ip ? ` (${boardUrl.ip})` : ""}` : boardUrl.loopback ? "This page is on localhost and /api/hosts returned no LAN address — a phone cannot reach this URL." : "Using this page's own address."}
                </p>
              </div>
            </div>
          </Panel>
        </div>

        {/* BOTTOM: events + soundtrack + inject */}
        <Panel title="Hearing events" className="col-span-2" right={<span className="num text-[10px] text-zinc-500">{hearing.length} events</span>}>
          <div className="grid grid-cols-[1.4fr_1fr] gap-6">
            <div className="min-h-[200px] max-h-[360px] overflow-y-auto">
              {hearing.length === 0 ? (
                <Empty>No hearing events yet. Play the soundtrack, tap a sound on the phone, or inject one.</Empty>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-[10px] uppercase tracking-widest text-zinc-500 sticky top-0 bg-ink-900">
                    <tr className="text-left">
                      <th className="py-1 font-semibold">Time</th>
                      <th className="py-1 font-semibold">Location</th>
                      <th className="py-1 font-semibold">Kind</th>
                      <th className="py-1 font-semibold">How</th>
                      <th className="py-1 font-semibold text-right">Conf.</th>
                      <th className="py-1 font-semibold">Heard as</th>
                      <th className="py-1 font-semibold text-right">dB</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hearing.slice(0, 40).map((e) => (
                      <EventRow key={e.id} e={e} />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] uppercase tracking-widest text-zinc-500">Soundtrack · truth vs detected</span>
                  <button className={`btn py-1 ${audio.source === "soundtrack" ? "btn-on" : ""}`} onClick={() => (audio.source === "soundtrack" ? audio.stop() : void audio.playSoundtrack())}>
                    {audio.source === "soundtrack" ? <Pause size={14} /> : <Music size={14} />} {audio.source === "soundtrack" ? "Stop" : "Play soundtrack"}
                  </button>
                </div>
                <SoundtrackTimeline truth={audio.truth} position={audio.position} duration={audio.duration} detections={hearing} startedAt={startedAt.current} finished={playbackFinished} />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Inject (fallback if the room is too loud)</div>
                <div className="grid grid-cols-5 gap-1.5">
                  {INJECT_KINDS.map((k) => {
                    const Icon = INJECT_ICON[k.kind];
                    return (
                      <button key={k.kind} className="btn justify-center py-2 px-1 text-xs flex-col gap-1" disabled={busy === k.kind} onClick={() => run(k.kind, () => api.hearingInject(k.kind, audio.location))} title={`POST /api/hearing/inject {kind: ${k.kind}}`}>
                        <Icon size={16} /> {k.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

type BoardUrl = { url: string; source: "lan" | "page"; ip?: string; loopback: boolean };

/** Phone-reachable sound-board URL: GET /api/hosts when the page is on localhost, else the page's own address. */
function useSoundBoardUrl(api: SousApi): BoardUrl {
  const loopback = isLoopbackHost();
  const [value, setValue] = useState<BoardUrl>({ url: soundBoardUrl(), source: "page", loopback });
  useEffect(() => {
    if (!loopback) return;
    let alive = true;
    api
      .hosts()
      .then((r) => {
        const h = r.hosts?.[0];
        if (alive && h?.url) setValue({ url: soundBoardUrlOn(h.url), source: "lan", ip: h.ip, loopback });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, loopback]);
  return value;
}

function EventRow({ e }: { e: Event }) {
  const d = e.data ?? {};
  const top = Array.isArray(d.top) && Array.isArray(d.top[0]) ? String((d.top[0] as unknown[])[0]) : null;
  const heardAs = typeof d.heard_as === "string" ? d.heard_as : top;
  const conf = typeof d.confidence === "number" ? d.confidence.toFixed(2) : "—";
  const db = typeof d.db === "number" ? d.db.toFixed(0) : "—";
  const how = typeof d.how === "string" ? d.how : e.kind === "taught" ? "taught" : "—";
  return (
    <tr className="border-t border-ink-700/70 animate-slideIn">
      <td className="py-1.5 num text-xs text-zinc-400">{clockTime(e.t)}</td>
      <td className="py-1.5 capitalize">{typeof d.location === "string" ? d.location : "—"}</td>
      <td className="py-1.5">
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <span className={`w-2 h-2 rounded-sm ${kindColor[e.kind] ?? "bg-zinc-400"}`} /> {e.kind.replace(/_/g, " ")}
        </span>
      </td>
      <td className="py-1.5">
        <span className={`pill ${how === "taught" ? "bg-violet-500/15 text-violet-300" : how === "injected" ? "bg-ink-700 text-zinc-400" : "bg-sky-500/15 text-sky-300"}`}>{how}</span>
      </td>
      <td className="py-1.5 num text-right">{conf}</td>
      <td className="py-1.5 text-zinc-300 truncate max-w-[180px]" title={heardAs ?? undefined}>
        {heardAs ?? "—"}
      </td>
      <td className="py-1.5 num text-right text-zinc-400">{db}</td>
    </tr>
  );
}
