// Stable identity for "this device" as a microphone. The id lives in localStorage so the same
// laptop/phone always shows up as the same mic on the Ears page across reloads.

export const MIC_LOCATIONS = ["kitchen", "front", "pass"] as const;
export type MicLocation = (typeof MIC_LOCATIONS)[number];

const ID_KEY = "sous_mic_id";
const LOC_KEY = "sous_mic_location";

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode etc. — the in-memory fallback below still works for this session */
  }
}

let memId: string | null = null;
let memLoc: string | null = null;

export function getMicId(): string {
  if (memId) return memId;
  const stored = safeGet(ID_KEY);
  if (stored && /^[a-z0-9]{6}$/.test(stored)) {
    memId = stored;
    return stored;
  }
  const fresh = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  safeSet(ID_KEY, fresh);
  memId = fresh;
  return fresh;
}

export function getMicLocation(): MicLocation {
  const v = memLoc ?? safeGet(LOC_KEY);
  return (MIC_LOCATIONS as readonly string[]).includes(v ?? "") ? (v as MicLocation) : "kitchen";
}

export function setMicLocation(loc: MicLocation): void {
  memLoc = loc;
  safeSet(LOC_KEY, loc);
}

/** Absolute URL of the phone sound board on the page's own host (fallback when LAN discovery is unavailable). */
export function soundBoardUrl(): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#/sounds`;
}

/** Sound-board URL on a backend-advertised LAN base such as "http://192.168.1.20:8000". */
export function soundBoardUrlOn(base: string): string {
  // /api/hosts may already return the full ".../#/sounds" URL; keep only origin + path.
  const root = base.split("#")[0].replace(/\/+$/, "");
  return `${root}/#/sounds`;
}

/** True when the page is served from a loopback host a phone could not reach. */
export function isLoopbackHost(hostname: string = window.location.hostname): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname === "0.0.0.0";
}
