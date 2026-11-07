import { useEffect, useState } from "react";
import { ControlBar } from "./components/ControlBar";
import { TopNav, VIEWS, type View } from "./components/TopNav";
import { useAudioStream, type AudioStreamState } from "./hooks/useAudioStream";
import { SousProvider, useSous } from "./hooks/useSous";
import { useVoice } from "./hooks/useVoice";
import { Board } from "./views/Board";
import { Ears } from "./views/Ears";
import { Kitchen } from "./views/Kitchen";
import { Nose } from "./views/Nose";
import { ScentRoom } from "./views/ScentRoom";
import { Sounds } from "./views/Sounds";
import { Storefront } from "./views/Storefront";

function viewFromHash(): View {
  const h = window.location.hash.replace(/^#\/?/, "").split(/[?/]/)[0] as View;
  return VIEWS.some((v) => v.id === h) ? h : "board";
}

/** Desktop/projector shell: nav, control bar, voice. This device's mic is owned by Shell so it keeps
 * streaming when the laptop opens a full-screen page (Sounds, phone-width Scent room) and comes back. */
function Desktop({ view, onChangeView, audio }: { view: View; onChangeView: (v: View) => void; audio: AudioStreamState }) {
  const { status, mock } = useSous();
  const voice = useVoice();
  return (
    <div className="h-full flex flex-col min-w-[1024px]">
      <TopNav view={view} onChange={onChangeView} />
      <ControlBar voice={voice} audio={audio} onChangeView={onChangeView} status={status} />
      {mock && (
        <div className="shrink-0 text-center text-[11px] py-1 bg-ink-900 text-zinc-400 border-b border-ink-800">
          Mock mode — an in-browser simulator is standing in for the backend. Remove <code>?mock=1</code> to connect to FastAPI on :8000.
        </div>
      )}
      {!mock && status !== "open" && (
        <div className="shrink-0 text-center text-[11px] py-1 bg-ink-900 text-warn border-b border-ink-800">
          {status === "connecting" ? "Connecting to the backend on /ws…" : "Backend unreachable — retrying with backoff. Append ?mock=1 to the URL to demo without it."}
        </div>
      )}
      <main className="flex-1 min-h-0">
        {view === "board" && <Board voice={voice} listening={audio.source === "mic"} />}
        {view === "ears" && <Ears audio={audio} />}
        {view === "nose" && <Nose />}
        {view === "room" && <ScentRoom />}
        {view === "kitchen" && <Kitchen />}
        {view === "storefront" && <Storefront />}
      </main>
    </div>
  );
}

const PHONE_QUERY = "(max-width: 767px)";

/** True on a phone-width viewport (the judge's phone scanning the scent-room QR). */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function Shell() {
  const [view, setView] = useState<View>(viewFromHash);
  const narrow = useNarrow();
  const audio = useAudioStream();   // lives above the view switch: leaving the shell must not cut the mic

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) window.history.replaceState(null, "", "#/board");
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const change = (v: View) => {
    window.location.hash = `/${v}`;
    setView(v);
  };

  // Phone page: minimal chrome, no control bar, no voice (the phone must not talk into the laptop's mic).
  if (view === "sounds") {
    return (
      <div className="min-h-full bg-ink-950">
        <Sounds />
      </div>
    );
  }
  // Scent room on a phone: same minimal chrome; on the projector it sits inside the normal shell.
  if (view === "room" && narrow) {
    return (
      <div className="min-h-full bg-ink-950">
        <ScentRoom phone />
      </div>
    );
  }
  return <Desktop view={view} onChangeView={change} audio={audio} />;
}

export default function App() {
  return (
    <SousProvider>
      <Shell />
    </SousProvider>
  );
}
