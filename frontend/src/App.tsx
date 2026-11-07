import { useEffect, useState } from "react";
import { ControlBar } from "./components/ControlBar";
import { TopNav, VIEWS, type View } from "./components/TopNav";
import { useAudioStream } from "./hooks/useAudioStream";
import { SousProvider, useSous } from "./hooks/useSous";
import { useVoice } from "./hooks/useVoice";
import { Board } from "./views/Board";
import { Ears } from "./views/Ears";
import { Kitchen } from "./views/Kitchen";
import { Nose } from "./views/Nose";
import { Sounds } from "./views/Sounds";
import { Storefront } from "./views/Storefront";

function viewFromHash(): View {
  const h = window.location.hash.replace(/^#\/?/, "").split(/[?/]/)[0] as View;
  return VIEWS.some((v) => v.id === h) ? h : "board";
}

/** Desktop/projector shell: nav, control bar, voice, this device's mic. */
function Desktop({ view, onChangeView }: { view: View; onChangeView: (v: View) => void }) {
  const { status, mock } = useSous();
  const voice = useVoice();
  const audio = useAudioStream();
  return (
    <div className="h-full flex flex-col min-w-[1024px]">
      <TopNav view={view} onChange={onChangeView} />
      <ControlBar voice={voice} audio={audio} onChangeView={onChangeView} status={status} />
      {mock && (
        <div className="shrink-0 text-center text-[11px] py-1 bg-fuchsia-500/10 text-fuchsia-300 border-b border-fuchsia-500/20">
          Mock mode — an in-browser simulator is standing in for the backend. Remove <code>?mock=1</code> to connect to FastAPI on :8000.
        </div>
      )}
      {!mock && status !== "open" && (
        <div className="shrink-0 text-center text-[11px] py-1 bg-warn/10 text-warn border-b border-warn/20">
          {status === "connecting" ? "Connecting to the backend on /ws…" : "Backend unreachable — retrying with backoff. Append ?mock=1 to the URL to demo without it."}
        </div>
      )}
      <main className="flex-1 min-h-0">
        {view === "board" && <Board voice={voice} listening={audio.source === "mic"} />}
        {view === "ears" && <Ears audio={audio} />}
        {view === "nose" && <Nose />}
        {view === "kitchen" && <Kitchen />}
        {view === "storefront" && <Storefront />}
      </main>
    </div>
  );
}

function Shell() {
  const [view, setView] = useState<View>(viewFromHash);

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
  return <Desktop view={view} onChangeView={change} />;
}

export default function App() {
  return (
    <SousProvider>
      <Shell />
    </SousProvider>
  );
}
