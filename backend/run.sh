#!/usr/bin/env bash
# Start the Sous backend on :8000. Set ANTHROPIC_API_KEY (or NOVA_TEAM_ID + NOVA_SERVER_URL) for the LLM,
# ELEVENLABS_API_KEY for server-side voice; without them it runs in rules + browser-voice mode.
cd "$(dirname "$0")"
exec ../.venv/bin/python -m uvicorn sous.api:app --host 0.0.0.0 --port 8000 "$@"
