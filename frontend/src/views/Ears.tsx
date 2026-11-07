import { Bell, DoorOpen, Mic, MicOff, Music, Pause, Phone, Printer, Smartphone, Trash2, Utensils } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Bar, Empty, Panel, Ring, ScoreBar } from "../components/common";
import { QrCode } from "../components/QrCode";
import { SoundtrackTimeline } from "../components/SoundtrackTimeline";
import type { AudioStreamState } from "../hooks/useAudioStream";
import { useSous } from "../hooks/useSous";
import { MIC_LOCATIONS } from "../lib/device";
import { usePhoneUrl } from "../lib/lanUrl";
import { clockTime, EVENT_SCORE_KEYS, INJECT_KINDS, kindColor, soundLabel } from "../lib/format";
import type { Event, HearingInjectKind, Mic as MicT } from "../types";

const INJECT_ICON: Record<HearingInjectKind, typeof Bell> = { ticket_burst: Printer, fryer_alarm: Bell, door_chime: DoorOpen, phone_ring: Phone, clatter: Utensils };

const dbPct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

function LevelWithFloor({ level, floor }: { level: number; floor: number }) {
  const lvl = dbPct(level);
  const fl = dbPct(floor);
  return (
    <div className="relative h-2 rounded-full bg-ink-700 overflow-hidden">
      <div className={`h-full rounded-full transition-[width] duration-200 ${lvl > 85 ? "bg-bad" : lvl > 65 ? "bg-warn" : "bg-ok"}`} style={{ width: `${lvl}%` }} />
      <span className="absolute top-0 h-full w-0.5 bg-zinc-400" style={{ left: `${fl}%` }} title={`noise floor ${floor.toFixed(0)} dB`} />
    </div>
  );
}

function MicCard({ mic, isThisDevice, names }: { mic: MicT; isThisDevice: boolean; names: Record<string, string> }) {
  const modelTone = mic.model === "yamnet" ? "bg-ok/10 text-ok" : mic.model === "loading" ? "bg-warn/10 text-warn" : "bg-ink-700 text-zinc-400";
  return (
    <article className={`rounded-lg border bg-ink-800/60 p-4 flex flex-col gap-3 ${mic.active ? "border-ink-700" : "border-ink-800 opacity-60"}`}>
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-flex items-center justify-center w-8 h-8 rounded-md bg-ink-700 ${mic.active ? "text-ok" : "text-zinc-500"}`}>
            <Mic size={16} />
          </span>
          <div className="min-w-0">
            <div className="text-base font-semibold leading-tight capitalize truncate">
              {mic.location}
              {isThisDevice && <span className="ml-2 text-[11px] font-normal text-zinc-500">this device</span>}
            </div>
            <div className="text-[11px] text-zinc-500 num truncate">
              {mic.mic} · {mic.windows} windows
            </div>
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <span className="pill bg-ink-700 text-zinc-400">{mic.source}</span>
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
        <div className="flex items-center gap-3 rounded-lg bg-accent/5 border border-accent/25 px-3 py-2">
          <Ring value={1 - mic.teaching.remaining_s / 4} size={40} stroke={4} color="#d9894f">
            <span className="num text-sm font-semibold">{Math.ceil(mic.teaching.remaining_s)}</span>
          </Ring>
          <div className="text-sm">
            <div className="font-medium">Teaching “{soundLabel(mic.teaching.label)}”</div>
            <div className="text-xs text-zinc-400">{mic.teaching.examples} examples so far — make the sound now</div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="label mb-1">What the AI hears</div>
          <div className="space-y-1">
            {mic.top.length ? mic.top.slice(0, 3).map(([name, score]) => <ScoreBar key={name} label={name} value={score} color="bg-zinc-500" />) : <div className="text-xs text-zinc-500">no windows yet</div>}
          </div>
        </div>
        <div>
          <div className="label mb-1">Kitchen events (zero-shot)</div>
          <div className="space-y-1">
            {EVENT_SCORE_KEYS.map((k) => (
              <ScoreBar key={k} label={soundLabel(k)} value={mic.scores[k] ?? 0} color={kindColor[k] ?? "bg-zinc-500"} highlight={(mic.scores[k] ?? 0) > 0.3} />
            ))}
          </div>
        </div>
      </div>
      {Object.keys(mic.taught).filter((k) => k !== "_background").length > 0 && (
        <div className="text-[11px] text-zinc-400 num">
          taught: {Object.entries(mic.taught).filter(([k]) => k !== "_background").map(([k, v]) => `${names[k] ?? soundLabel(k)} ${v.toFixed(2)}`).join(" · ")}
        </div>
      )}
    </article>
  );
}

export function Ears({ audio }: { audio: AudioStreamState }) {
  const { state, events, api, mock } = useSous();
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [teachError, setTeachError] = useState<string | null>(null);
  const teachingRef = useRef<{ label: string; mic: string } | null>(null);
  const startedAt = useRef<number | null>(null);
  const boardUrl = usePhoneUrl(api, "sounds");

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
    setToast(
      proto
        ? { ok: true, text: `Learned ${proto.examples} example${proto.examples === 1 ? "" : "s"} of “${proto.name}”` }
        : { ok: false, text: `Nothing captured for “${soundLabel(t.label)}” — the sound was not loud enough above the room. Try again closer to the mic.` },
    );
    const h = window.setTimeout(() => setToast(null), 6000);
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
  const liveMics = ears.mics.filter((m) => m.active).length;
  const protoNames = Object.fromEntries(ears.prototypes.map((p) => [p.label, p.name]));

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-[1400px] mx-auto grid grid-cols-[1.25fr_1fr] gap-4 content-start">
        <header className="col-span-2 flex items-center justify-between">
          <div>
            <div className="label">Ears · microphones → few-shot sound events</div>
            <h1 className="text-xl font-semibold leading-tight text-zinc-100 flex items-center gap-2"><span className={`w-1.5 h-1.5 rounded-full ${liveMics ? "bg-ok" : "bg-zinc-600"}`} />{liveMics ? `Listening on ${liveMics} mic${liveMics === 1 ? "" : "s"}` : "No mic connected"}</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className={`pill border border-ink-700 bg-ink-900 ${liveMics ? "text-ok" : "text-zinc-500"}`}>{liveMics ? `${liveMics} live` : "no live mic"}</span>
            <span className="pill bg-ink-900 text-zinc-500 border border-ink-700">model · {ears.model}</span>
            <span className="pill bg-ink-900 text-zinc-500 border border-ink-700">provider · {state.providers.ears}</span>
          </div>
        </header>

        {/* LEFT: microphones */}
        <div className="flex flex-col gap-4">
          <Panel title="Microphones">
            <div className="flex flex-col gap-3">
              {ears.mics.length === 0 && <Empty>No microphone connected. Tap Listen on this device, or open the sound board on a phone.</Empty>}
              {ears.mics.map((m) => (
                <MicCard key={m.mic} mic={m} isThisDevice={m.mic === audio.micId} names={protoNames} />
              ))}
            </div>
          </Panel>

          <Panel title="This device" right={<span className="num text-[11px] text-zinc-600">mic id {audio.micId}</span>}>
            <div className="flex items-center gap-3 flex-wrap">
              <button className={`btn py-2 px-4 ${audio.source === "mic" ? "btn-on" : "btn-accent"}`} onClick={() => (audio.source === "mic" ? audio.stop() : void audio.startMic())}>
                {audio.source === "mic" ? <Mic size={16} /> : <MicOff size={16} />} {audio.source === "mic" ? "Listening" : "Listen"}
              </button>
              <label className="btn cursor-pointer gap-2">
                <span className="text-xs text-zinc-400">at</span>
                <select className="bg-transparent outline-none text-sm font-medium" value={audio.location} onChange={(e) => audio.setLocation(e.target.value as (typeof MIC_LOCATIONS)[number])}>
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
          <Panel title="Teach Sous a sound" right={<span className="text-[11px] text-zinc-500">takes 4 s</span>}>
            <p className="text-xs text-zinc-400 mb-3">
              Press a label, then make the sound for four seconds{teachMic ? ` into the ${teachMic.location} mic (${teachMic.mic})` : ""}. Sous memorises it as a prototype and recognises it from then on — what you taught beats the zero-shot guess.
            </p>
            <div className="flex flex-wrap gap-2">
              {ears.labels.map((l) => {
                const known = taught.find((p) => p.label === l.id);
                const active = teachingNow?.label === l.id;
                return (
                  <button key={l.id} className={`btn py-2 ${active ? "btn-accent animate-firePulse" : known ? "text-zinc-100" : "text-zinc-400"}`} disabled={!!teachingNow || busy === `teach-${l.id}`} onClick={() => teach(l.id)}>
                    {l.name}
                    {known && <span className="num text-[10px] text-zinc-400">· {known.examples}</span>}
                  </button>
                );
              })}
            </div>
            {teachingNow && (
              <div className="mt-4 flex items-center gap-4 rounded-lg bg-accent/5 border border-accent/25 px-4 py-3">
                <Ring value={1 - teachingNow.remaining_s / 4} size={56} stroke={5} color="#d9894f">
                  <span className="num text-lg font-medium">{Math.ceil(teachingNow.remaining_s)}</span>
                </Ring>
                <div>
                  <div className="text-base font-semibold">Make the sound now</div>
                  <div className="text-sm text-zinc-400">
                    Teaching “{soundLabel(teachingNow.label)}” · {teachingNow.examples} examples captured
                  </div>
                </div>
              </div>
            )}
            {toast && <div className={`mt-3 rounded-lg border px-3 py-2 text-sm animate-slideIn ${toast.ok ? "bg-ok/5 border-ok/25 text-ok" : "bg-warn/5 border-warn/25 text-warn"}`}>{toast.text}</div>}
            {teachError && <div className="mt-3 text-xs text-bad">{teachError}</div>}

            <div className="mt-4">
              <div className="label mb-1.5">Learned sounds</div>
              {taught.length === 0 ? (
                <div className="text-xs text-zinc-500">Nothing taught yet — Sous is using its built-in sound knowledge alone.</div>
              ) : (
                <ul className="divide-y divide-ink-800">
                  {taught.map((p) => (
                    <li key={p.label} className="flex items-center gap-3 py-1.5">
                      <span className="font-medium text-zinc-200 flex-1">{p.name}</span>
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
                {boardUrl.source === "pending" ? <div className="rounded-lg bg-ink-800" style={{ width: 128, height: 128 }} /> : <QrCode text={boardUrl.url} size={128} />}
                <a href={boardUrl.url} className="num text-[11px] text-zinc-400 hover:text-zinc-200 hover:underline break-all text-center max-w-[160px]">
                  {boardUrl.url.replace(/^https?:\/\//, "")}
                </a>
              </div>
              <div className="text-sm text-zinc-400">
                <p>Scan to open the sound board. Tap a clip on the phone; this laptop listens and the board lights up when Sous hears it.</p>
                <p className="text-[11px] text-zinc-500 mt-1.5">
                  {boardUrl.note}
                </p>
              </div>
            </div>
          </Panel>
        </div>

        {/* BOTTOM: events + soundtrack + inject */}
        <Panel title="Hearing events" className="col-span-2" right={<span className="num text-[11px] text-zinc-600">{hearing.length} events</span>}>
          <div className="grid grid-cols-[1.4fr_1fr] gap-6">
            <div className="min-h-[200px] max-h-[360px] overflow-y-auto">
              {hearing.length === 0 ? (
                <Empty>No hearing events yet. Play the soundtrack, tap a sound on the phone, or inject one.</Empty>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-[11px] text-zinc-500 sticky top-0 bg-ink-900">
                    <tr className="text-left">
                      <th className="py-1 px-2 first:pl-0 font-medium">Time</th>
                      <th className="py-1 px-2 first:pl-0 font-medium">Location</th>
                      <th className="py-1 px-2 first:pl-0 font-medium">Kind</th>
                      <th className="py-1 px-2 first:pl-0 font-medium">How</th>
                      <th className="py-1 px-2 first:pl-0 font-medium text-right">Conf.</th>
                      <th className="py-1 px-2 first:pl-0 font-medium">Heard as</th>
                      <th className="py-1 px-2 first:pl-0 font-medium text-right">dB</th>
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
                  <span className="label">Soundtrack · truth vs detected</span>
                  <button className={`btn py-1 ${audio.source === "soundtrack" ? "btn-on" : ""}`} onClick={() => (audio.source === "soundtrack" ? audio.stop() : void audio.playSoundtrack())}>
                    {audio.source === "soundtrack" ? <Pause size={14} /> : <Music size={14} />} {audio.source === "soundtrack" ? "Stop" : "Play soundtrack"}
                  </button>
                </div>
                <SoundtrackTimeline truth={audio.truth} position={audio.position} duration={audio.duration} detections={hearing} startedAt={startedAt.current} finished={playbackFinished} />
              </div>
              <div>
                <div className="label mb-2">Inject (fallback if the room is too loud)</div>
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

function EventRow({ e }: { e: Event }) {
  const d = e.data ?? {};
  const top = Array.isArray(d.top) && Array.isArray(d.top[0]) ? String((d.top[0] as unknown[])[0]) : null;
  const heardAs = typeof d.heard_as === "string" ? d.heard_as : top;
  const conf = typeof d.confidence === "number" ? d.confidence.toFixed(2) : "—";
  const db = typeof d.db === "number" ? d.db.toFixed(0) : "—";
  const how = typeof d.how === "string" ? d.how : e.kind === "taught" ? "taught" : "—";
  return (
    <tr className="border-t border-ink-800 animate-slideIn">
      <td className="py-1.5 px-2 first:pl-0 num text-xs text-zinc-400">{clockTime(e.t)}</td>
      <td className="py-1.5 px-2 first:pl-0 capitalize text-zinc-400">{typeof d.location === "string" ? d.location : "—"}</td>
      <td className="py-1.5 px-2 first:pl-0">
        <span className="inline-flex items-center gap-1.5 text-zinc-200">
          <span className={`w-1.5 h-1.5 rounded-full ${kindColor[e.kind] ?? "bg-zinc-400"}`} /> {soundLabel(e.kind)}
        </span>
      </td>
      <td className="py-1.5 px-2 first:pl-0">
        <span className={`pill ${how === "taught" ? "bg-ink-700 text-zinc-200" : how === "injected" ? "bg-ink-800 text-zinc-500" : "bg-ink-700 text-zinc-400"}`}>{how}</span>
      </td>
      <td className="py-1.5 px-2 first:pl-0 num text-right">{conf}</td>
      <td className="py-1.5 px-2 first:pl-0 text-zinc-400 truncate max-w-[180px]" title={heardAs ?? undefined}>
        {heardAs ?? "—"}
      </td>
      <td className="py-1.5 px-2 first:pl-0 num text-right text-zinc-400">{db}</td>
    </tr>
  );
}
