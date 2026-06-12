#!/usr/bin/env bash
# Start backend and frontend together.
# Usage: ./start.sh
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Backend ──────────────────────────────────────────────────────────────────
if [ ! -d "$ROOT/.venv" ]; then
  echo "[setup] Creating Python venv…"
  python3 -m venv "$ROOT/.venv"
  "$ROOT/.venv/bin/pip" install -q -r "$ROOT/requirements.txt"
fi

echo "[backend] Starting FastAPI server on http://localhost:8000 …"
"$ROOT/.venv/bin/uvicorn" backend.server:app \
  --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

# ── Frontend ─────────────────────────────────────────────────────────────────
echo "[frontend] Starting React dev server on http://localhost:3000 …"
cd "$ROOT" && npm start &
FRONTEND_PID=$!

# ── Cleanup on exit ───────────────────────────────────────────────────────────
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM

echo ""
echo "  Backend  → http://localhost:8000"
echo "  Frontend → http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop both."
wait
