import { Volume2, VolumeX } from "lucide-react";
import type { VoiceState } from "../hooks/useVoice";

/** The Sous says panel (kept from the v1 Live view). */
export function VoicePanel({ voice, lastLine, phrasedByLlm = false }: { voice: VoiceState; lastLine: string; phrasedByLlm?: boolean }) {
  const line = voice.current ?? lastLine;
  const glowing = voice.speaking && !voice.muted;
  return (
    <section className={`panel px-6 py-3 text-center transition-colors ${glowing ? "border-accent/25" : ""}`}>
      <div className="flex items-center justify-center gap-2 mb-1.5">
        <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full ${voice.muted ? "bg-ink-700 text-zinc-500" : "bg-accent/10 text-accent"} ${glowing ? "animate-speakGlow" : ""}`}>
          {voice.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </span>
        <span className="label">
          Sous says{voice.muted ? " · muted" : ""}
          {voice.queued > 0 ? ` · ${voice.queued} queued` : ""}
        </span>
      </div>
      <p className={`text-lg font-medium leading-snug max-w-5xl mx-auto line-clamp-2 ${line ? "text-zinc-100" : "text-zinc-500 italic"}`} title={line || undefined}>
        {line || "Quiet for now — the line is on pace."}
      </p>
      {phrasedByLlm && line && <div className="text-[11px] text-zinc-600 mt-1">phrased by LLM</div>}
    </section>
  );
}
