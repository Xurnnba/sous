import { Volume2, VolumeX } from "lucide-react";
import type { VoiceState } from "../hooks/useVoice";

/** The big SOUS SAYS panel (kept from the v1 Live view). */
export function VoicePanel({ voice, lastLine, phrasedByLlm = false }: { voice: VoiceState; lastLine: string; phrasedByLlm?: boolean }) {
  const line = voice.current ?? lastLine;
  const glowing = voice.speaking && !voice.muted;
  return (
    <section className={`panel px-8 py-4 text-center transition-colors ${glowing ? "border-accent/50" : ""}`}>
      <div className="flex items-center justify-center gap-3 mb-2">
        <span className={`inline-flex items-center justify-center w-10 h-10 rounded-full ${voice.muted ? "bg-ink-700 text-zinc-500" : "bg-accent/20 text-accent-soft"} ${glowing ? "animate-speakGlow" : ""}`}>
          {voice.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </span>
        <span className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">
          Sous says{voice.muted ? " · muted" : ""}
          {voice.queued > 0 ? ` · ${voice.queued} queued` : ""}
        </span>
      </div>
      <p className={`text-2xl font-semibold leading-snug max-w-5xl mx-auto line-clamp-2 ${line ? "text-zinc-50" : "text-zinc-500 italic"}`} title={line || undefined}>
        {line || "Quiet for now — the line is on pace."}
      </p>
      {phrasedByLlm && line && <div className="text-[10px] text-zinc-500 italic mt-1">phrased by LLM</div>}
    </section>
  );
}
