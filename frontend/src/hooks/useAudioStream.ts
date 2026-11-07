import { useCallback, useEffect, useRef, useState } from "react";
import type { SoundtrackTruth } from "../types";

const TARGET_RATE = 16000;
const FRAME_MS = 250;
const FRAME_SAMPLES = (TARGET_RATE * FRAME_MS) / 1000; // 4000 samples -> 8000 bytes

export type AudioSource = "mic" | "soundtrack";

export type AudioStreamState = {
  source: AudioSource | null;
  level: number; // 0..1 RMS of the most recent block
  wsState: "idle" | "connecting" | "open" | "closed" | "error";
  framesSent: number;
  /** Soundtrack playback position in seconds (0 when idle). */
  position: number;
  duration: number;
  truth: SoundtrackTruth | null;
  error: string | null;
  startMic: () => Promise<void>;
  playSoundtrack: () => Promise<void>;
  stop: () => void;
};

// AudioWorklet processor source, loaded from a Blob URL so no extra public file is needed.
const WORKLET_SRC = `
class SousCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("sous-capture", SousCapture);
`;

/** Linear-interpolation resampler Float32 -> Int16 @16 kHz. Keeps a fractional read cursor across calls. */
class Resampler {
  private carry = new Float32Array(0);
  private pos = 0;
  constructor(private readonly inRate: number) {}
  push(input: Float32Array): Int16Array {
    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry);
    buf.set(input, this.carry.length);
    const ratio = this.inRate / TARGET_RATE;
    const outLen = Math.max(0, Math.floor((buf.length - 1 - this.pos) / ratio));
    const out = new Int16Array(outLen);
    let p = this.pos;
    for (let i = 0; i < outLen; i++) {
      const i0 = Math.floor(p);
      const frac = p - i0;
      const s = buf[i0] * (1 - frac) + buf[i0 + 1] * frac;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      p += ratio;
    }
    const consumed = Math.floor(p);
    this.carry = buf.slice(consumed);
    this.pos = p - consumed;
    return out;
  }
}

function rms(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
  return Math.sqrt(sum / Math.max(1, block.length));
}

const isMock = () => new URLSearchParams(window.location.search).get("mock") === "1";

/** Synthesised 75 s "kitchen" soundtrack used only in mock mode when /api/demo is unreachable. */
function synthSoundtrack(ctx: BaseAudioContext): { buffer: AudioBuffer; truth: SoundtrackTruth } {
  const dur = 75;
  const sr = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, dur * sr, sr);
  const d = buffer.getChannelData(0);
  // low-level pink-ish hum
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const white = Math.random() * 2 - 1;
    last = 0.98 * last + 0.02 * white;
    d[i] = last * 0.25;
  }
  const tone = (t0: number, len: number, hz: number, gain: number, pulses = 1) => {
    for (let p = 0; p < pulses; p++) {
      const start = Math.floor((t0 + p * 0.35) * sr);
      const n = Math.floor(len * sr);
      for (let i = 0; i < n && start + i < d.length; i++) {
        const env = Math.min(1, i / (0.01 * sr)) * Math.min(1, (n - i) / (0.05 * sr));
        d[start + i] += Math.sin((2 * Math.PI * hz * i) / sr) * gain * env;
      }
    }
  };
  const burst = (t0: number, len: number, gain: number) => {
    const start = Math.floor(t0 * sr);
    const n = Math.floor(len * sr);
    for (let i = 0; i < n && start + i < d.length; i++) d[start + i] += (Math.random() * 2 - 1) * gain * (1 - i / n);
  };
  const truth: SoundtrackTruth = { duration_s: dur, events: [] };
  const add = (t: number, kind: string, label: string) => truth.events.push({ t, kind, label });
  tone(8, 0.6, 1760, 0.5); tone(8.7, 0.6, 2093, 0.5); add(8, "door_chime", "Door chime");
  burst(18, 0.08, 0.9); burst(18.4, 0.08, 0.9); burst(18.8, 0.08, 0.9); burst(19.2, 0.08, 0.9); add(18, "ticket_burst", "Ticket burst");
  tone(31, 0.25, 2800, 0.6, 8); add(31, "fryer_alarm", "Fryer alarm");
  burst(45, 0.3, 1.0); add(45, "noise_spike", "Dropped pan");
  burst(55, 0.08, 0.9); burst(55.4, 0.08, 0.9); burst(55.8, 0.08, 0.9); add(55, "ticket_burst", "Ticket burst");
  tone(66, 0.6, 1760, 0.5); tone(66.7, 0.6, 2093, 0.5); add(66, "door_chime", "Door chime");
  for (let i = 0; i < d.length; i++) d[i] = Math.max(-1, Math.min(1, d[i]));
  return { buffer, truth };
}

export function useAudioStream(): AudioStreamState {
  const [source, setSource] = useState<AudioSource | null>(null);
  const [level, setLevel] = useState(0);
  const [wsState, setWsState] = useState<AudioStreamState["wsState"]>("idle");
  const [framesSent, setFramesSent] = useState(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [truth, setTruth] = useState<SoundtrackTruth | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const nodesRef = useRef<AudioNode[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<Int16Array[]>([]);
  const pendingLenRef = useRef(0);
  const framesRef = useRef(0);
  const lastLevelPush = useRef(0);

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try {
      sourceNodeRef.current?.stop();
    } catch {
      /* already stopped */
    }
    sourceNodeRef.current = null;
    nodesRef.current.forEach((n) => {
      try {
        n.disconnect();
      } catch {
        /* noop */
      }
    });
    nodesRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) wsRef.current.close();
    wsRef.current = null;
    ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
    pendingRef.current = [];
    pendingLenRef.current = 0;
    setSource(null);
    setLevel(0);
    setPosition(0);
    setWsState("idle");
  }, []);

  useEffect(() => stop, [stop]);

  const openWs = (src: AudioSource) =>
    new Promise<WebSocket | null>((resolve) => {
      if (isMock()) {
        setWsState("open");
        return resolve(null); // mock: no backend; frames are counted but dropped
      }
      setWsState("connecting");
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/audio`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        ws.send(JSON.stringify({ source: src, sample_rate: TARGET_RATE }));
        setWsState("open");
        resolve(ws);
      };
      ws.onerror = () => {
        setWsState("error");
        resolve(null);
      };
      ws.onclose = () => setWsState((s) => (s === "error" ? s : "closed"));
    });

  /** Accumulate Int16 samples and flush exactly FRAME_SAMPLES per binary frame. */
  const pushPcm = (chunk: Int16Array) => {
    if (!chunk.length) return;
    pendingRef.current.push(chunk);
    pendingLenRef.current += chunk.length;
    while (pendingLenRef.current >= FRAME_SAMPLES) {
      const frame = new Int16Array(FRAME_SAMPLES);
      let filled = 0;
      while (filled < FRAME_SAMPLES) {
        const head = pendingRef.current[0];
        const take = Math.min(head.length, FRAME_SAMPLES - filled);
        frame.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.length) pendingRef.current.shift();
        else pendingRef.current[0] = head.subarray(take);
      }
      pendingLenRef.current -= FRAME_SAMPLES;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame.buffer);
      framesRef.current += 1;
      if (framesRef.current % 4 === 0) setFramesSent(framesRef.current);
    }
  };

  const onBlock = (block: Float32Array, resampler: Resampler) => {
    const now = performance.now();
    if (now - lastLevelPush.current > 80) {
      lastLevelPush.current = now;
      setLevel(Math.min(1, rms(block) * 3));
    }
    pushPcm(resampler.push(block));
  };

  /** Builds a capture node (AudioWorklet when available, else ScriptProcessor) and wires it to `input`. */
  const attachCapture = async (ctx: AudioContext, input: AudioNode): Promise<void> => {
    const resampler = new Resampler(ctx.sampleRate);
    const sink = ctx.createGain();
    sink.gain.value = 0; // capture path must be silent; playback goes via its own connection
    sink.connect(ctx.destination);
    nodesRef.current.push(sink);
    if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(ctx, "sous-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        node.port.onmessage = (e: MessageEvent<Float32Array>) => onBlock(e.data, resampler);
        input.connect(node);
        node.connect(sink);
        nodesRef.current.push(node);
        return;
      } catch (err) {
        console.warn("AudioWorklet unavailable, falling back to ScriptProcessorNode", err);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (e) => onBlock(e.inputBuffer.getChannelData(0), resampler);
    input.connect(sp);
    sp.connect(sink);
    nodesRef.current.push(sp);
  };

  const startMic = useCallback(async () => {
    stop();
    setError(null);
    framesRef.current = 0;
    setFramesSent(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      nodesRef.current.push(src);
      wsRef.current = await openWs("mic");
      await attachCapture(ctx, src);
      setSource("mic");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone unavailable");
      stop();
    }
  }, [stop]); // eslint-disable-line react-hooks/exhaustive-deps

  const playSoundtrack = useCallback(async () => {
    stop();
    setError(null);
    framesRef.current = 0;
    setFramesSent(0);
    try {
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.resume();
      let buffer: AudioBuffer;
      let truthData: SoundtrackTruth | null = null;
      try {
        const [wavRes, jsonRes] = await Promise.all([fetch("/api/demo/soundtrack.wav"), fetch("/api/demo/soundtrack.json")]);
        if (!wavRes.ok) throw new Error(`soundtrack.wav ${wavRes.status}`);
        buffer = await ctx.decodeAudioData(await wavRes.arrayBuffer());
        if (jsonRes.ok) {
          const raw = (await jsonRes.json()) as unknown;
          truthData = normaliseTruth(raw);
        }
      } catch (err) {
        if (!isMock()) throw err;
        const s = synthSoundtrack(ctx);
        buffer = s.buffer;
        truthData = s.truth;
      }
      setTruth(truthData);
      setDuration(buffer.duration);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      sourceNodeRef.current = node;
      node.connect(ctx.destination); // speakers
      wsRef.current = await openWs("soundtrack");
      await attachCapture(ctx, node); // PCM to /ws/audio, paced by real-time playback
      const t0 = ctx.currentTime;
      node.start();
      setSource("soundtrack");
      const tickPos = () => {
        setPosition(Math.min(buffer.duration, ctx.currentTime - t0));
        rafRef.current = requestAnimationFrame(tickPos);
      };
      tickPos();
      node.onended = () => stop();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Soundtrack unavailable");
      stop();
    }
  }, [stop]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fetch the ground truth so the timeline can show markers before play.
  useEffect(() => {
    if (isMock()) return;
    fetch("/api/demo/soundtrack.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((raw) => raw && setTruth(normaliseTruth(raw)))
      .catch(() => undefined);
  }, []);

  return { source, level, wsState, framesSent, position, duration, truth, error, startMic, playSoundtrack, stop };
}

/** The contract says "ground-truth event timestamps" without a fixed shape; accept a few plausible ones. */
function normaliseTruth(raw: unknown): SoundtrackTruth {
  const r = raw as Record<string, unknown>;
  const list = (Array.isArray(raw) ? raw : (r.events ?? r.markers ?? r.truth ?? [])) as unknown[];
  const events = list
    .map((e) => {
      const o = e as Record<string, unknown>;
      const t = Number(o.t ?? o.time ?? o.start ?? o.at ?? o.t_s ?? o.seconds);
      const kind = String(o.kind ?? o.type ?? o.label ?? "event");
      const label = typeof o.label === "string" ? o.label : undefined;
      return Number.isFinite(t) ? { t, kind, label } : null;
    })
    .filter((x): x is { t: number; kind: string; label: string | undefined } => x !== null);
  const duration = Number(r.duration_s ?? r.duration ?? r.length_s);
  return { duration_s: Number.isFinite(duration) ? duration : undefined, events };
}
