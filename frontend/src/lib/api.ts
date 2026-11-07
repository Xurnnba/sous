import type { ControlBody, HearingInjectKind, SmellScenario, State } from "../types";

// Thin REST client for every endpoint in CONTRACT.md. Each helper is replaceable in
// mock mode (see mock/mockBackend.ts), so the UI never has to know which mode it is in.
export type SousApi = {
  health: () => Promise<{ ok: boolean; providers: State["providers"]; smell_device: string }>;
  getState: () => Promise<State>;
  control: (body: ControlBody) => Promise<void>;
  reset: () => Promise<void>;
  restoreMenuItem: (id: string) => Promise<void>;
  smellScenario: (name: SmellScenario) => Promise<void>;
  sensorReading: (body: {
    sensor_id: string;
    location: string;
    gas_ohm: number;
    temp_c: number;
    rh: number;
    pressure_hpa?: number;
    t?: number;
  }) => Promise<void>;
  hearingInject: (kind: HearingInjectKind) => Promise<void>;
  /** Returns an MP3 blob when the server has a TTS provider; null on 204 (use speechSynthesis). */
  speak: (text: string) => Promise<Blob | null>;
};

async function postJson(path: string, body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method: "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res;
}

export const httpApi: SousApi = {
  health: () => fetch("/api/health").then((r) => r.json()),
  getState: () => fetch("/api/state").then((r) => r.json()),
  control: (body) => postJson("/api/control", body).then(() => undefined),
  reset: () => postJson("/api/reset").then(() => undefined),
  restoreMenuItem: (id) => postJson(`/api/menu/${encodeURIComponent(id)}/restore`).then(() => undefined),
  smellScenario: (name) => postJson("/api/smell/scenario", { name }).then(() => undefined),
  sensorReading: (body) => postJson("/api/sensor/reading", body).then(() => undefined),
  hearingInject: (kind) => postJson("/api/hearing/inject", { kind }).then(() => undefined),
  speak: async (text) => {
    const res = await postJson("/api/speak", { text });
    if (res.status === 204) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("audio")) return null;
    return res.blob();
  },
};

export const isMockMode = (): boolean => new URLSearchParams(window.location.search).get("mock") === "1";
