import type { ControlBody, HearingInjectKind, HostsResponse, Items, SensorReadingBody, SmellScenario, SoundClip, State } from "../types";

// Thin REST client for every endpoint in CONTRACT.md. Each helper is replaceable in
// mock mode (see mock/mockBackend.ts), so the UI never has to know which mode it is in.
export type SousApi = {
  health: () => Promise<{ ok: boolean; providers: Partial<State["providers"]>; smell_device: string; mics?: unknown }>;
  getState: () => Promise<State>;
  control: (body: ControlBody) => Promise<void>;
  reset: () => Promise<void>;
  restoreMenuItem: (id: string) => Promise<void>;
  getItems: () => Promise<Items>;
  itemDone: (id: string) => Promise<void>;
  itemDismiss: (id: string) => Promise<void>;
  smellScenario: (name: SmellScenario) => Promise<void>;
  sensorReading: (body: SensorReadingBody) => Promise<void>;
  earTeach: (body: { label: string; mic?: string; seconds?: number }) => Promise<void>;
  earPrototypes: () => Promise<{ prototypes: State["senses"]["ears"]["prototypes"] }>;
  earForget: (label: string) => Promise<void>;
  hearingInject: (kind: HearingInjectKind, location?: string) => Promise<void>;
  sounds: () => Promise<{ clips: SoundClip[] }>;
  /** LAN addresses the backend is reachable on, for the phone QR code. */
  hosts: () => Promise<HostsResponse>;
  /** Returns an MP3 blob when the server has a TTS provider; null on 204 (no ElevenLabs clip: show the line, don't speak it). */
  speak: (text: string) => Promise<Blob | null>;
};

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res;
}
const postJson = (path: string, body?: unknown) => request("POST", path, body);

export const httpApi: SousApi = {
  health: () => fetch("/api/health").then((r) => r.json()),
  getState: () => fetch("/api/state").then((r) => r.json()),
  control: (body) => postJson("/api/control", body).then(() => undefined),
  reset: () => postJson("/api/reset").then(() => undefined),
  restoreMenuItem: (id) => postJson(`/api/menu/${encodeURIComponent(id)}/restore`).then(() => undefined),
  getItems: () => fetch("/api/items").then((r) => r.json()),
  itemDone: (id) => postJson(`/api/items/${encodeURIComponent(id)}/done`).then(() => undefined),
  itemDismiss: (id) => postJson(`/api/items/${encodeURIComponent(id)}/dismiss`).then(() => undefined),
  smellScenario: (name) => postJson("/api/smell/scenario", { name }).then(() => undefined),
  sensorReading: (body) => postJson("/api/sensor/reading", body).then(() => undefined),
  earTeach: (body) => postJson("/api/ear/teach", { seconds: 4, ...body }).then(() => undefined),
  earPrototypes: () => fetch("/api/ear/prototypes").then((r) => r.json()),
  earForget: (label) => request("DELETE", `/api/ear/prototypes/${encodeURIComponent(label)}`).then(() => undefined),
  hearingInject: (kind, location) => postJson("/api/hearing/inject", location ? { kind, location } : { kind }).then(() => undefined),
  sounds: () => fetch("/api/sounds").then((r) => (r.ok ? r.json() : { clips: [] })),
  hosts: () => fetch("/api/hosts").then((r) => (r.ok ? r.json() : { port: 0, hosts: [] })),
  speak: async (text) => {
    const res = await postJson("/api/speak", { text });
    if (res.status === 204) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("audio")) return null;
    return res.blob();
  },
};

export const isMockMode = (): boolean => new URLSearchParams(window.location.search).get("mock") === "1";
