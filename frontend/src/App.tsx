import { useEffect, useState } from "react";
import { ControlBar } from "./components/ControlBar";
import { TopNav, VIEWS, type View } from "./components/TopNav";
import { VoiceBar } from "./components/VoiceBar";
import { useAudioStream } from "./hooks/useAudioStream";
import { SousProvider, useSous } from "./hooks/useSous";
import { useVoice } from "./hooks/useVoice";
import { BackOffice } from "./views/BackOffice";
import { Kitchen } from "./views/Kitchen";
import { Live } from "./views/Live";
import { Senses } from "./views/Senses";
import { Storefront } from "./views/Storefront";

function viewFromHash(): View {
  const h = window.location.hash.replace(/^#\/?/, "") as View;
  return VIEWS.some((v) => v.id === h) ? h : "live";
}

function Shell() {
  const { state, status, mock, actions } = useSous();
  const voice = useVoice();
  const audio = useAudioStream();
  const [view, setView] = useState<View>(viewFromHash);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const lastSpeak = actions.find((a) => a.type === "speak") ?? state?.actions.find((a) => a.type === "speak");
  const phrasedByLlm = !!state && state.providers.llm !== "rules" && lastSpeak?.by === "llm";

  const change = (v: View) => {
    window.location.hash = `/${v}`;
    setView(v);
  };

  return (
    <div className="h-full flex flex-col min-w-[1024px]">
      <TopNav view={view} onChange={change} />
      <ControlBar voice={voice} audio={audio} onChangeView={change} status={status} />
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
        {view === "live" && <Live voice={voice} />}
        {view === "kitchen" && <Kitchen />}
        {view === "storefront" && <Storefront />}
        {view === "backoffice" && <BackOffice />}
        {view === "senses" && <Senses audio={audio} />}
      </main>
      <VoiceBar voice={voice} lastLine={state?.voice.last_line ?? ""} phrasedByLlm={phrasedByLlm} />
    </div>
  );
}

export default function App() {
  return (
    <SousProvider>
      <Shell />
    </SousProvider>
  );
}
