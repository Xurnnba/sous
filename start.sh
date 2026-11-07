#!/usr/bin/env bash
# One command to run Sous: builds the frontend if needed, then serves everything on :8000.
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv && .venv/bin/pip install -q -r backend/requirements.txt
fi
if [ ! -f frontend/dist/index.html ] || [ -n "$(find frontend/src -newer frontend/dist/index.html -type f 2>/dev/null | head -1)" ]; then
  (cd frontend && [ -d node_modules ] || npm install --silent) && (cd frontend && npm run build --silent)
fi
echo "Sous → http://localhost:8000  (Live tab · press Run demo)"
exec backend/run.sh "$@"
