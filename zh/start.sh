#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use."
  echo "Open: http://127.0.0.1:$PORT"
  exit 0
fi
echo "Starting… default admin: admin / admin123"
echo "Local:  http://127.0.0.1:$PORT"
LAN=$(ipconfig getifaddr en0 2>/dev/null || true)
[ -n "${LAN:-}" ] && echo "LAN:    http://$LAN:$PORT"
echo "Ctrl+C to stop"
export PORT
exec python3 server.py
