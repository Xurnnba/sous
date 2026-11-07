import { useEffect, useState } from "react";
import type { SousApi } from "./api";
import { isLoopbackHost } from "./device";

/** A phone-reachable URL for one of the app's hash routes, and where its host came from. */
export type PhoneUrl = { url: string; source: "lan" | "page" | "pending"; ip?: string; loopback: boolean };

/** Absolute URL of `#/<route>` on the page's own host (fallback when LAN discovery is unavailable). */
export function pageRouteUrl(route: string): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#/${route}`;
}

/** `#/<route>` on a backend-advertised LAN base such as "http://192.168.1.20:8000". */
export function lanRouteUrl(base: string, route: string): string {
  // /api/hosts may already return a full ".../#/sounds" URL; keep only origin + path.
  const root = base.split("#")[0].replace(/\/+$/, "");
  return `${root}/#/${route}`;
}

// The LAN address does not change while the page is open: remember it so revisiting a page is instant.
let lanHostCache: { url: string; ip: string } | null = null;

/** Phone-reachable URL of `#/<route>`: GET /api/hosts when the page is on localhost, else the page's own address. */
export function usePhoneUrl(api: SousApi, route: string): PhoneUrl {
  const loopback = isLoopbackHost();
  const [value, setValue] = useState<PhoneUrl>(() =>
    lanHostCache ? { url: lanRouteUrl(lanHostCache.url, route), source: "lan", ip: lanHostCache.ip, loopback } : { url: pageRouteUrl(route), source: loopback ? "pending" : "page", loopback },
  );
  useEffect(() => {
    if (lanHostCache) {
      setValue({ url: lanRouteUrl(lanHostCache.url, route), source: "lan", ip: lanHostCache.ip, loopback });
      return;
    }
    if (!loopback) return;
    let alive = true;
    let timer: number | null = null;
    const attempt = (n: number) => {
      api
        .hosts()
        .then((r) => {
          const h = r.hosts?.[0];
          if (!alive) return;
          if (h?.url) {
            lanHostCache = { url: h.url, ip: h.ip };
            setValue({ url: lanRouteUrl(h.url, route), source: "lan", ip: h.ip, loopback });
          } else throw new Error("no LAN host");
        })
        .catch(() => {
          if (!alive) return;
          if (n < 3) timer = window.setTimeout(() => attempt(n + 1), 1500);
          else setValue((v) => ({ ...v, source: "page" }));
        });
    };
    attempt(0);
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [api, loopback, route]);
  return value;
}
