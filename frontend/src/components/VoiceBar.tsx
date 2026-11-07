import { Volume2, VolumeX } from "lucide-react";
import type { VoiceState } from "../hooks/useVoice";

export function VoiceBar({ voice, lastLine, phrasedByLlm = false }: { voice: VoiceState; lastLine: string; phrasedByLlm?: boolean }) {
  const text = voice.current ?? lastLine;
  return (
    <div className="shrink-0 border-t border-ink-700 bg-ink-900/95 backdrop-blur px-5 py-3 flex items-center gap-4">
      <div className="flex items-center gap-2 shrink-0">
        <span className={`inline-flex items-center justify-center w-9 h-9 rounded-full ${voice.muted ? "bg-ink-700 text-zinc-500" : "bg-accent/20 text-accent-soft"} ${voice.speaking && !voice.muted ? "animate-speakGlow" : voice.speaking ? "animate-pulseRing" : ""}`}>
          {voice.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </span>
        <div className="flex items-end gap-[3px] h-6 w-10">
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={`flex-1 rounded-sm origin-bottom ${voice.speaking && !voice.muted ? "bg-accent animate-wave" : "bg-ink-600 scale-y-[0.3]"}`}
              style={{ animationDelay: `${i * 0.12}s` }}
            />
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          Sous says{voice.queued > 0 ? ` · ${voice.queued} queued` : ""}
          {voice.muted ? " · muted" : ""}
        </div>
        <p className={`line-clamp-2 text-lg md:text-xl font-medium ${text ? "text-zinc-50" : "text-zinc-500 italic"}`}>{text || "Quiet for now — the line is on pace."}</p>
        {phrasedByLlm && text && <div className="text-[10px] text-zinc-500 italic mt-0.5">phrased by LLM</div>}
      </div>
    </div>
  );
}
