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

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const preferred = en.find((v) => /google us english|samantha|daniel|natural|neural/i.test(v.name));
  return preferred ?? en[0] ?? voices[0] ?? null;
}

/**
 * Serial voice queue. Every `speak` frame is spoken once, in order, never overlapping.
 * Each line first tries POST /api/speak (audio/mpeg); 204 -> window.speechSynthesis.
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

  const synth = (text: string) =>
    new Promise<void>((resolve) => {
      const ss = window.speechSynthesis;
      if (!ss) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.lang = v?.lang ?? "en-US";
      u.rate = 1.05;
      u.pitch = 1;
      u.onend = u.onerror = () => resolve();
      // Safety: some browsers never fire onend if the tab is backgrounded.
      const guard = window.setTimeout(resolve, Math.max(4000, text.length * 90));
      u.onend = () => {
        window.clearTimeout(guard);
        resolve();
      };
      ss.cancel();
      ss.speak(u);
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
        else await synth(next.text);
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

  // Warm the voice list (Chrome loads voices async).
  useEffect(() => {
    window.speechSynthesis?.getVoices();
    const h = () => window.speechSynthesis?.getVoices();
    window.speechSynthesis?.addEventListener?.("voiceschanged", h);
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", h);
  }, []);

  const setMuted = useCallback(
    (m: boolean) => {
      mutedRef.current = m;
      setMutedState(m);
      if (m) {
        window.speechSynthesis?.cancel();
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

  // In mock mode browsers block speech before a user gesture; that's fine, the bar still shows text.
  void mock;

  return { current, speaking, queued, muted, setMuted, say };
}
