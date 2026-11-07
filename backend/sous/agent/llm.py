"""LLM provider shim. Three modes, picked from the environment:

* ``anthropic`` when ANTHROPIC_API_KEY is set (model from SOUS_MODEL, default claude-sonnet-5-5)
* ``nova``      when NOVA_TEAM_ID and NOVA_SERVER_URL are set (the hackathon's own model proxy)
* ``rules``     otherwise: the agent still works, the voice just uses templated lines

Every call has a hard timeout and falls back to the rules text, so a slow or dead API can never
stall the demo.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, Optional

PROVIDER = "rules"
_client: Any = None
MODEL = os.environ.get("SOUS_MODEL", "claude-sonnet-5-5")
TIMEOUT_S = float(os.environ.get("SOUS_LLM_TIMEOUT", "6"))

if os.environ.get("ANTHROPIC_API_KEY"):
    try:
        import anthropic  # type: ignore
        _client = anthropic.AsyncAnthropic()
        PROVIDER = "anthropic"
    except Exception:  # pragma: no cover
        PROVIDER = "rules"
elif os.environ.get("NOVA_TEAM_ID") and os.environ.get("NOVA_SERVER_URL"):
    try:
        from nova_sdk import Message, NovaClient  # type: ignore
        _client = NovaClient(team_id=os.environ["NOVA_TEAM_ID"], server_url=os.environ["NOVA_SERVER_URL"])
        PROVIDER = "nova"
    except Exception:  # pragma: no cover
        PROVIDER = "rules"

SYSTEM = (
    "You are Sous, the expeditor voice of a small restaurant kitchen. You hear the kitchen "
    "(microphone events), smell it (a VOC gas sensor) and see the order stream. You speak to line "
    "cooks over a speaker: terse, calm, concrete, one or two short sentences, no filler, no emojis, "
    "numbers as digits. When asked for JSON, return only JSON."
)


async def _complete(prompt: str, max_tokens: int = 200) -> Optional[str]:
    if PROVIDER == "rules" or _client is None:
        return None
    try:
        if PROVIDER == "anthropic":
            resp = await asyncio.wait_for(
                _client.messages.create(model=MODEL, max_tokens=max_tokens, system=SYSTEM,
                                        messages=[{"role": "user", "content": prompt}]),
                timeout=TIMEOUT_S)
            return "".join(getattr(b, "text", "") for b in resp.content).strip()
        if PROVIDER == "nova":
            loop = asyncio.get_running_loop()

            def _call():
                from nova_sdk import Message  # type: ignore
                msg = Message()
                msg.add_text(SYSTEM + "\n\n" + prompt)
                out = _client.process_message(msg, output_modality="text")
                return out if isinstance(out, str) else str(out)
            return await asyncio.wait_for(loop.run_in_executor(None, _call), timeout=TIMEOUT_S)
    except Exception:
        return None
    return None


async def rewrite_line(rules_line: str, context: str) -> tuple[str, str]:
    """Return (line, by). Rewrites a templated expeditor line in Sous's voice; falls back silently."""
    out = await _complete(
        f"Context:\n{context}\n\nSay this to the line in your own words, max 28 words, keep every "
        f"number and order id exactly:\n\"{rules_line}\"")
    if out:
        return out.strip().strip('"'), "llm"
    return rules_line, "rules"


async def fuse_smell(context: str, default: dict) -> tuple[dict, str]:
    """Ask the model to label a VOC anomaly given context. Returns (decision, by).
    decision = {kind, confidence, action, line}. ``action`` in {promote, alert, change_oil, ignore, ask_human}."""
    out = await _complete(
        f"{context}\n\nDecide what this VOC rise most likely is and what to do. Return JSON with keys "
        f"kind (spoilage|burning|oil_degraded|cleaning|unknown), confidence (0-1), action "
        f"(promote|alert|change_oil|ignore|ask_human), line (what you say aloud, max 30 words). "
        f"If the signature is ambiguous, prefer ask_human over acting.", max_tokens=220)
    if out:
        m = re.search(r"\{.*\}", out, re.S)
        if m:
            try:
                d = json.loads(m.group(0))
                if {"kind", "action", "line"} <= set(d):
                    d.setdefault("confidence", 0.5)
                    return d, "llm"
            except json.JSONDecodeError:
                pass
    return default, "rules"
