#!/usr/bin/env bash
# Start the Sous backend on :8000. Set ANTHROPIC_API_KEY (or NOVA_TEAM_ID + NOVA_SERVER_URL) for the LLM,
# ELEVENLABS_API_KEY for server-side voice. Without a key only the pre-rendered lines in voice_cache/
# are spoken; other lines are shown on screen but never read by the browser's default voice.
# Keys can live in a git-ignored .env at the repo root (KEY=value per line).
cd "$(dirname "$0")"
if [ -f ../.env ]; then set -a; . ../.env; set +a; fi
exec ../.venv/bin/python -m uvicorn sous.api:app --host 0.0.0.0 --port 8000 "$@"
