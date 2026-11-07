import { useCallback, useEffect, useRef, useState } from "react";
import type { View } from "../components/TopNav";
import type { SousApi } from "../lib/api";

/**
 * One-click demo autopilot. Every step is a client-side timer; tune the `at` seconds below.
 * `view` switches are fire-and-forget hash changes, so the operator can click around freely
 * while the script runs — the next step simply switches the tab again.
 */
export type DemoStep = {
  /** Seconds after "Run demo" was clicked. */
  at: number;
  /** Short caption for the progress chip. */
  label: string;
  run: (ctx: DemoContext) => void | Promise<void>;
};

export type DemoContext = {
  api: SousApi;
  go: (view: View) => void;
  playSoundtrack: () => Promise<void>;
};

export const DEMO_STEPS: DemoStep[] = [
  {
    at: 0,
    label: "reset · rush",
    run: async ({ api, go }) => {
      await api.reset();
      await api.control({ rush: true, speed: 1 });
      go("kitchen");
    },
  },
  { at: 3, label: "ears", run: ({ playSoundtrack }) => playSoundtrack() },
  { at: 45, label: "storefront", run: ({ go }) => go("storefront") },
  {
    at: 60,
    label: "nose · spoilage",
    run: async ({ api, go }) => {
      go("senses");
      await api.smellScenario("spoilage_walkin");
    },
  },
  { at: 85, label: "back office", run: ({ go }) => go("backoffice") },
  {
    at: 100,
    label: "nose · burning",
    run: async ({ api, go }) => {
      await api.smellScenario("burning");
      go("kitchen");
    },
  },
  { at: 120, label: "nose · cleaning", run: ({ api }) => api.smellScenario("cleaning") },
  { at: 140, label: "nose · nominal", run: ({ api }) => api.smellScenario("nominal") },
];

const COMPLETE_LINGER_MS = 5000;

export type DemoState = {
  running: boolean;
  /** 1-based index of the step most recently fired; 0 before the first. */
  step: number;
  total: number;
  label: string;
  complete: boolean;
  start: () => void;
  stop: () => void;
};

export function useDemo(ctx: DemoContext): DemoState {
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState(0);
  const [complete, setComplete] = useState(false);
  const timers = useRef<number[]>([]);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  const stop = useCallback(() => {
    clearTimers();
    setRunning(false);
    setStep(0);
    setComplete(false);
    ctxRef.current.api.smellScenario("nominal").catch(() => undefined);
  }, [clearTimers]);

  const start = useCallback(() => {
    clearTimers();
    setComplete(false);
    setStep(0);
    setRunning(true);
    DEMO_STEPS.forEach((s, i) => {
      timers.current.push(
        window.setTimeout(() => {
          setStep(i + 1);
          Promise.resolve()
            .then(() => s.run(ctxRef.current))
            .catch((err) => console.warn(`demo step ${i + 1} (${s.label})`, err));
          if (i === DEMO_STEPS.length - 1) {
            setRunning(false);
            setComplete(true);
            timers.current.push(window.setTimeout(() => setComplete(false), COMPLETE_LINGER_MS));
          }
        }, s.at * 1000),
      );
    });
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  return {
    running,
    step,
    total: DEMO_STEPS.length,
    label: step > 0 ? DEMO_STEPS[step - 1].label : "starting",
    complete,
    start,
    stop,
  };
}
