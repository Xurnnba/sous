"""Action items: the agent's output, and the only thing an owner has to look at.

Every signal the senses produce is translated into zero or one *item*: a short imperative title,
an urgency bucket, what Sous already did about it (if anything), and the evidence behind it.
Items are serialisable, deduplicated, auto-expire when they stop mattering, and persist to disk.

Urgency buckets (what the owner sees as three columns):
  now    - someone should act in the next minute (alarm with no ticket, Dasher at the door, burning)
  next   - within the next 15 minutes (change the oil before the rush, stock about to run out)
  today  - before close (produce turning, skip tomorrow's order)
  later  - informational; auto-expires (cleaning spike ignored, mic came online)
"""
from __future__ import annotations

import itertools
import json
import time
from pathlib import Path
from typing import Callable, Optional

URGENCY_RANK = {"now": 0, "next": 1, "today": 2, "later": 3}
DEFAULT_EXPIRES_S = {"now": 180.0, "next": 900.0, "today": 4 * 3600.0, "later": 120.0}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


class ItemStore:
    def __init__(self, path: Path, on_change: Callable[[dict, str], None]):
        self.path = path
        self.on_change = on_change        # (item, "added" | "updated" | "closed")
        self.items: list[dict] = []
        self._seq = itertools.count(1)
        self._load()

    # ------------------------------------------------------------------ persistence
    def _load(self) -> None:
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text())
                self.items = data.get("items", [])
                self._seq = itertools.count(data.get("seq", len(self.items) + 1))
            except Exception:
                self.items = []

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"seq": next(itertools.islice(self._seq, 0, 1)) if False else self._peek_seq(),
                                         "items": self.items[-300:]}, indent=0))

    def _peek_seq(self) -> int:
        # itertools.count has no peek; keep a shadow counter
        return getattr(self, "_last_id", 0) + 1

    # ------------------------------------------------------------------ api
    def add(self, *, title: str, detail: str, urgency: str, sense: str, kind: str, key: Optional[str] = None,
            auto: Optional[dict] = None, evidence: Optional[dict] = None, speak: Optional[str] = None,
            expires_s: Optional[float] = None, location: Optional[str] = None) -> tuple[dict, bool]:
        """Add or update. ``key`` dedupes: an open item with the same key is updated (count++) instead of
        duplicated. Returns (item, is_new)."""
        if key:
            for it in self.items:
                if it["status"] == "open" and it.get("key") == key:
                    it["count"] = it.get("count", 1) + 1
                    it["detail"] = detail
                    it["updated"] = now_iso()
                    it["expires_at"] = time.time() + (expires_s or DEFAULT_EXPIRES_S[urgency])
                    if evidence:
                        it["evidence"] = evidence
                    self._save()
                    self.on_change(it, "updated")
                    return it, False
        iid = next(self._seq)
        self._last_id = iid
        it = {
            "id": f"i{iid}", "created": now_iso(), "updated": now_iso(), "title": title, "detail": detail,
            "urgency": urgency, "sense": sense, "kind": kind, "key": key, "status": "open", "count": 1,
            "auto": auto, "evidence": evidence or {}, "speak": speak, "location": location,
            "expires_at": time.time() + (expires_s or DEFAULT_EXPIRES_S[urgency]),
        }
        self.items.append(it)
        self._save()
        self.on_change(it, "added")
        return it, True

    def close(self, iid: str, status: str = "done", by: str = "owner") -> Optional[dict]:
        for it in self.items:
            if it["id"] == iid and it["status"] == "open":
                it["status"], it["closed"], it["closed_by"] = status, now_iso(), by
                self._save()
                self.on_change(it, "closed")
                return it
        return None

    def resolve(self, predicate: Callable[[dict], bool], by: str = "sous") -> list[dict]:
        """Auto-resolve open items matching a predicate (e.g. Dasher handed off, air cleared)."""
        out = []
        for it in self.items:
            if it["status"] == "open" and predicate(it):
                it["status"], it["closed"], it["closed_by"] = "done", now_iso(), by
                out.append(it)
        if out:
            self._save()
            for it in out:
                self.on_change(it, "closed")
        return out

    def tick(self) -> None:
        now = time.time()
        for it in self.items:
            if it["status"] == "open" and it["expires_at"] and now > it["expires_at"]:
                it["status"], it["closed"], it["closed_by"] = "expired", now_iso(), "timeout"
                self.on_change(it, "closed")
        if len(self.items) > 300:
            del self.items[:-300]

    def clear(self) -> None:
        self.items = []
        self._save()

    def open_items(self) -> list[dict]:
        return sorted((i for i in self.items if i["status"] == "open"),
                      key=lambda i: (URGENCY_RANK[i["urgency"]], i["created"]))

    def snapshot(self) -> dict:
        open_ = self.open_items()
        closed = [i for i in self.items if i["status"] != "open"][-12:][::-1]
        return {
            "open": open_, "recent_closed": closed,
            "counts": {u: sum(1 for i in open_ if i["urgency"] == u) for u in URGENCY_RANK},
            "total_created": getattr(self, "_last_id", 0),
        }
