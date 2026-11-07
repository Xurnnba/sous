import { useCallback, useEffect, useRef, useState } from "react";
import { useSous, type SpeakMessage } from "./useSous";

export type VoiceState = {
  current: string | null;
  speaking: boolean;
  queued: number;
  muted: boolean;
  setMuted: (m: boolean) => void;
  /** Speak something locally (e.g. a test line); goes through the same queue. */
  say: (text: string) => void;
};

/**
 * Serial voice queue. Every `speak` frame is spoken once, in order, never overlapping.
 * Each line is played from POST /api/speak (ElevenLabs audio/mpeg). If the server has no ElevenLabs
 * clip for it (204), the line is shown but not spoken: the browser's built-in voice is never used.
 */
export function useVoice(): VoiceState {
  const { onSpeak, api, state, mock } = useSous();
  const [current, setCurrent] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [queued, setQueued] = useState(0);
  const [muted, setMutedState] = useState(false);
  const mutedRef = useRef(false);
  const queue = useRef<SpeakMessage[]>([]);
  const busy = useRef(false);
  const seen = useRef<Set<string>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Mirror server-side mute into the local flag (the server is the source of truth once connected).
  useEffect(() => {
    if (state) {
      mutedRef.current = state.voice.muted;
      setMutedState(state.voice.muted);
    }
  }, [state?.voice.muted]); // eslint-disable-line react-hooks/exhaustive-deps

  const playBlob = (blob: Blob) =>
    new Promise<void>((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = audio.onerror = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        resolve();
      };
      audio.play().catch(() => resolve());
    });

  const drain = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    while (queue.current.length) {
      const next = queue.current.shift()!;
      setQueued(queue.current.length);
      if (mutedRef.current) {
        setCurrent(next.text);
        continue;
      }
      setCurrent(next.text);
      setSpeaking(true);
      try {
        const blob = await api.speak(next.text).catch(() => null);
        if (blob) await playBlob(blob);
      } finally {
        setSpeaking(false);
      }
    }
    busy.current = false;
  }, [api]);

  const enqueue = useCallback(
    (m: SpeakMessage) => {
      if (seen.current.has(m.id)) return;
      seen.current.add(m.id);
      queue.current.push(m);
      setQueued(queue.current.length);
      void drain();
    },
    [drain],
  );

  useEffect(() => onSpeak(enqueue), [onSpeak, enqueue]);

  const setMuted = useCallback(
    (m: boolean) => {
      mutedRef.current = m;
      setMutedState(m);
      if (m) {
        audioRef.current?.pause();
        queue.current = [];
        setQueued(0);
        setSpeaking(false);
      }
      api.control({ muted: m }).catch(() => undefined);
    },
    [api],
  );

  const say = useCallback(
    (text: string) => enqueue({ text, id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }),
    [enqueue],
  );

  // Mock mode has no ElevenLabs provider, so lines are shown, not spoken.
  void mock;

  return { current, speaking, queued, muted, setMuted, say };
}
