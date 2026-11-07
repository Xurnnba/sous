import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { httpApi, isMockMode, type SousApi } from "../lib/api";
import { countItems, normaliseState } from "../lib/normalise";
import { createMockBackend } from "../mock/mockBackend";
import type { Action, ConnectionStatus, Event, Item, State, WsMessage } from "../types";

const MAX_FEED = 160;

export type SpeakMessage = { text: string; id: string };
type SpeakListener = (m: SpeakMessage) => void;
type EventListener = (e: Event) => void;

export type SousContextValue = {
  state: State | null;
  events: Event[];
  actions: Action[];
  status: ConnectionStatus;
  mock: boolean;
  api: SousApi;
  /** Subscribe to `{type:"speak"}` frames. Returns an unsubscribe fn. */
  onSpeak: (cb: SpeakListener) => () => void;
  /** Subscribe to every `{type:"event"}` frame as it arrives (for latency-sensitive UI like the sound board). */
  onEvent: (cb: EventListener) => () => void;
  /** Close an item (Done / Dismiss) with an optimistic local update; the next snapshot reconciles. */
  closeItem: (id: string, how: "done" | "dismiss") => Promise<void>;
  /** Items the owner just closed locally and the snapshot has not confirmed yet. */
  pendingClosed: Set<string>;
};

const SousContext = createContext<SousContextValue | null>(null);

function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

function applyItemChange(state: State, change: "added" | "updated" | "closed", item: Item): State {
  const open = state.items.open.filter((i) => i.id !== item.id);
  if (change !== "closed" && item.status === "open") open.unshift(item);
  const recent_closed = change === "closed" ? [item, ...state.items.recent_closed.filter((i) => i.id !== item.id)].slice(0, 20) : state.items.recent_closed;
  return {
    ...state,
    items: {
      ...state.items,
      open,
      recent_closed,
      counts: countItems(open),
      total_created: change === "added" && !state.items.open.some((i) => i.id === item.id) ? state.items.total_created + 1 : state.items.total_created,
    },
  };
}

export function SousProvider({ children }: { children: ReactNode }) {
  const mock = useMemo(isMockMode, []);
  const [state, setState] = useState<State | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>(mock ? "mock" : "connecting");
  const [pendingClosed, setPendingClosed] = useState<Set<string>>(() => new Set());
  const speakListeners = useRef<Set<SpeakListener>>(new Set());
  const eventListeners = useRef<Set<EventListener>>(new Set());
  const seenActionIds = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Map<string, number>>(new Map()); // id -> closed at (ms)

  const handleMessage = useCallback((msg: WsMessage) => {
    switch (msg.type) {
      case "snapshot": {
        const s = normaliseState(msg.state);
        // Drop optimistic closes once the server agrees (or after 10 s regardless).
        const now = Date.now();
        const stillOpen = new Set(s.items.open.map((i) => i.id));
        let changed = false;
        for (const [id, at] of pendingRef.current) {
          if (!stillOpen.has(id) || now - at > 10_000) {
            pendingRef.current.delete(id);
            changed = true;
          }
        }
        if (changed) setPendingClosed(new Set(pendingRef.current.keys()));
        if (pendingRef.current.size) {
          const open = s.items.open.filter((i) => !pendingRef.current.has(i.id));
          s.items = { ...s.items, open, counts: countItems(open) };
        }
        setState(s);
        setActions((prev) => {
          const fresh = s.actions.filter((a) => !seenActionIds.current.has(a.id));
          if (!fresh.length) return prev;
          fresh.forEach((a) => seenActionIds.current.add(a.id));
          return [...fresh, ...prev].slice(0, MAX_FEED);
        });
        break;
      }
      case "event":
        setEvents((prev) => (prev.some((e) => e.id === msg.event.id) ? prev : [msg.event, ...prev].slice(0, MAX_FEED)));
        eventListeners.current.forEach((cb) => cb(msg.event));
        break;
      case "action":
        if (!seenActionIds.current.has(msg.action.id)) {
          seenActionIds.current.add(msg.action.id);
          setActions((prev) => [msg.action, ...prev].slice(0, MAX_FEED));
        }
        break;
      case "item":
        if (pendingRef.current.has(msg.item.id) && msg.change !== "closed") break;
        setState((prev) => (prev ? applyItemChange(prev, msg.change, msg.item) : prev));
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
    httpApi
      .getState()
      .then((s) => setState((prev) => prev ?? normaliseState(s)))
      .catch(() => undefined);

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

  const onEvent = useCallback((cb: EventListener) => {
    eventListeners.current.add(cb);
    return () => {
      eventListeners.current.delete(cb);
    };
  }, []);

  const api = mock ? mockRef.current!.api : httpApi;

  const closeItem = useCallback(
    async (id: string, how: "done" | "dismiss") => {
      pendingRef.current.set(id, Date.now());
      setPendingClosed(new Set(pendingRef.current.keys()));
      setState((prev) => {
        if (!prev) return prev;
        const item = prev.items.open.find((i) => i.id === id);
        if (!item) return prev;
        return applyItemChange(prev, "closed", { ...item, status: how === "done" ? "done" : "dismissed", closed: new Date().toISOString(), closed_by: "owner" });
      });
      try {
        await (how === "done" ? api.itemDone(id) : api.itemDismiss(id));
      } catch (err) {
        console.warn(`item ${how}`, err);
        pendingRef.current.delete(id);
        setPendingClosed(new Set(pendingRef.current.keys()));
      }
    },
    [api],
  );

  const value = useMemo<SousContextValue>(
    () => ({ state, events, actions, status, mock, api, onSpeak, onEvent, closeItem, pendingClosed }),
    [state, events, actions, status, mock, api, onSpeak, onEvent, closeItem, pendingClosed],
  );

  return <SousContext.Provider value={value}>{children}</SousContext.Provider>;
}

export function useSous(): SousContextValue {
  const ctx = useContext(SousContext);
  if (!ctx) throw new Error("useSous must be used inside <SousProvider>");
  return ctx;
}
