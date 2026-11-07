import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { httpApi, isMockMode, type SousApi } from "../lib/api";
import { createMockBackend } from "../mock/mockBackend";
import type { Action, ConnectionStatus, Event, State, WsMessage } from "../types";

const MAX_FEED = 120;

export type SpeakMessage = { text: string; id: string };
type SpeakListener = (m: SpeakMessage) => void;

export type SousContextValue = {
  state: State | null;
  events: Event[];
  actions: Action[];
  status: ConnectionStatus;
  mock: boolean;
  api: SousApi;
  /** Subscribe to `{type:"speak"}` frames. Returns an unsubscribe fn. */
  onSpeak: (cb: SpeakListener) => () => void;
};

const SousContext = createContext<SousContextValue | null>(null);

function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

export function SousProvider({ children }: { children: ReactNode }) {
  const mock = useMemo(isMockMode, []);
  const [state, setState] = useState<State | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>(mock ? "mock" : "connecting");
  const speakListeners = useRef<Set<SpeakListener>>(new Set());
  const seenActionIds = useRef<Set<string>>(new Set());

  const handleMessage = useCallback((msg: WsMessage) => {
    switch (msg.type) {
      case "snapshot": {
        setState(msg.state);
        // Backfill actions from the snapshot so a late-joining client has history.
        setActions((prev) => {
          const fresh = msg.state.actions.filter((a) => !seenActionIds.current.has(a.id));
          if (!fresh.length) return prev;
          fresh.forEach((a) => seenActionIds.current.add(a.id));
          return [...fresh, ...prev].slice(0, MAX_FEED);
        });
        break;
      }
      case "event":
        setEvents((prev) => (prev.some((e) => e.id === msg.event.id) ? prev : [msg.event, ...prev].slice(0, MAX_FEED)));
        break;
      case "action":
        if (!seenActionIds.current.has(msg.action.id)) {
          seenActionIds.current.add(msg.action.id);
          setActions((prev) => [msg.action, ...prev].slice(0, MAX_FEED));
        }
        break;
      case "speak":
        speakListeners.current.forEach((cb) => cb({ text: msg.text, id: msg.id }));
        break;
    }
  }, []);

  // --- mock mode -----------------------------------------------------------
  const mockRef = useRef<ReturnType<typeof createMockBackend> | null>(null);
  if (mock && mockRef.current === null) mockRef.current = createMockBackend(handleMessage);

  useEffect(() => {
    if (!mock) return;
    const backend = mockRef.current!;
    backend.start();
    return () => backend.stop();
  }, [mock]);

  // --- real mode: WebSocket with exponential backoff -----------------------
  useEffect(() => {
    if (mock) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let retryTimer: number | null = null;

    const connect = () => {
      if (closed) return;
      setStatus("connecting");
      ws = new WebSocket(wsUrl("/ws"));
      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
      };
      ws.onmessage = (ev) => {
        try {
          handleMessage(JSON.parse(ev.data as string) as WsMessage);
        } catch (err) {
          console.warn("bad ws frame", err);
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setStatus("closed");
        const delay = Math.min(10_000, 500 * 2 ** attempt++);
        retryTimer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    // Also pull a REST snapshot straight away so the board fills before the first WS frame.
    httpApi.getState().then((s) => setState((prev) => prev ?? s)).catch(() => undefined);

    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [mock, handleMessage]);

  const onSpeak = useCallback((cb: SpeakListener) => {
    speakListeners.current.add(cb);
    return () => {
      speakListeners.current.delete(cb);
    };
  }, []);

  const api = mock ? mockRef.current!.api : httpApi;

  const value = useMemo<SousContextValue>(
    () => ({ state, events, actions, status, mock, api, onSpeak }),
    [state, events, actions, status, mock, api, onSpeak],
  );

  return <SousContext.Provider value={value}>{children}</SousContext.Provider>;
}

export function useSous(): SousContextValue {
  const ctx = useContext(SousContext);
  if (!ctx) throw new Error("useSous must be used inside <SousProvider>");
  return ctx;
}
