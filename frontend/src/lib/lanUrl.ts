import { useEffect, useState } from "react";
import type { SousApi } from "./api";
import { isLoopbackHost } from "./device";

/**
 * A phone-reachable URL for one of the app's hash routes.
 * Preference: the exe.dev HTTPS proxy URL (works from any network once the VM is shared), then the
 * laptop's LAN address (same Wi-Fi only), then the page's own address.
 */
export type PhoneUrl = {
  url: string;
  source: "proxy" | "lan" | "page" | "pending";
  /** One plain sentence on who can open the URL. */
  note: string;
};

export function pageRouteUrl(route: string): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#/${route}`;
}

/** `#/<route>` on a base such as "http://192.168.1.20:8000" or "https://vm.exe.xyz/". */
export function routeOn(base: string, route: string): string {
  const root = base.split("#")[0].replace(/\/+$/, "");
  return `${root}/#/${route}`;
}

type Resolved = { kind: "proxy" | "lan"; base: string; vm?: string; defaultPort?: boolean; ip?: string };
// The answer does not change while the page is open: remember it so revisiting a page is instant.
let cache: Resolved | null = null;

function describe(r: Resolved, route: string): PhoneUrl {
  if (r.kind === "proxy") {
    const note = r.defaultPort
      ? `exe.dev link. Any phone can open it once the VM is public (ssh exe.dev share set-public ${r.vm}); while it is private, phones are asked to log in to exe.dev.`
      : `exe.dev link on a non-default port, so only people with access to the VM can open it. Make this the default port (ssh exe.dev share port ${r.vm} <port>) to share it publicly.`;
    return { url: routeOn(r.base, route), source: "proxy", note };
  }
  return { url: routeOn(r.base, route), source: "lan", note: `Laptop's network address${r.ip ? ` (${r.ip})` : ""}: works for phones on the same Wi-Fi.` };
}

export function usePhoneUrl(api: SousApi, route: string): PhoneUrl {
  const loopback = isLoopbackHost();
  const fallback = (): PhoneUrl => ({
    url: pageRouteUrl(route),
    source: "page",
    note: loopback ? "This page is on localhost and no other address was found, so a phone can't reach it." : "Using this page's own address.",
  });
  const [value, setValue] = useState<PhoneUrl>(() => (cache ? describe(cache, route) : { url: pageRouteUrl(route), source: "pending", note: "Looking up an address phones can reach…" }));
  useEffect(() => {
    if (cache) {
      setValue(describe(cache, route));
      return;
    }
    let alive = true;
    let timer: number | null = null;
    const attempt = (n: number) => {
      api
        .hosts()
        .then((r) => {
          if (!alive) return;
          if (r.proxy?.url) cache = { kind: "proxy", base: r.proxy.url, vm: r.proxy.vm, defaultPort: r.proxy.default_port };
          else if (loopback && r.hosts?.[0]?.url) cache = { kind: "lan", base: r.hosts[0].url, ip: r.hosts[0].ip };
          else return setValue(fallback());
          setValue(describe(cache, route));
        })
        .catch(() => {
          if (!alive) return;
          if (n < 3) timer = window.setTimeout(() => attempt(n + 1), 1500);
          else setValue(fallback());
        });
    };
    attempt(0);
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, loopback, route]);
  return value;
}
