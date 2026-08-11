#!/bin/sh
# 9router-vfh — run production (native standalone, port 2222)
# Usage: ./run-prod.sh           # build + start
#        ./run-prod.sh stop      # stop the running server
#        ./run-prod.sh restart   # stop, build, start
set -e

PORT=2222
HOSTNAME=0.0.0.0
BASE_URL="http://localhost:${PORT}"
LOG_FILE="/tmp/9router-vfh.log"
PID_FILE="/tmp/9router-vfh.pid"

stop_server() {
  # Kill the process listening on PORT. fuser is more reliable than lsof here
  # (lsof -sTCP:LISTEN can return empty for next-server).
  if command -v fuser >/dev/null 2>&1; then
    PID=$(fuser "$PORT/tcp" 2>/dev/null | tr -d ' ' | head -1)
    if [ -n "$PID" ]; then
      echo "Stopping 9router-vfh on port $PORT (PID $PID)..."
      kill "$PID" 2>/dev/null || true
      sleep 1
      kill -9 "$PID" 2>/dev/null || true
      sleep 1
    fi
  fi
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    kill "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  # Fallback: kill any leftover standalone server process
  pkill -f "standalone/server.js" 2>/dev/null || true
  sleep 2
}

start_server() {
  # Stop any running instance first — .next is locked while the server runs.
  stop_server

  echo "Building 9router-vfh..."
  npm run build >/dev/null 2>&1 \
    || { echo "Build failed — see output below"; npm run build; exit 1; }

  echo "Starting 9router-vfh on port $PORT..."
  PORT="$PORT" HOSTNAME="$HOSTNAME" NEXT_PUBLIC_BASE_URL="$BASE_URL" \
    DATA_DIR="$HOME/.9router-vfh" \
    nohup node .next/standalone/server.js > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 4
  if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/login" | grep -q 200; then
    echo "✓ 9router-vfh live at ${BASE_URL}"
  else
    echo "⚠ Server started but not responding yet — check $LOG_FILE"
  fi
}

case "${1:-start}" in
  stop)   stop_server ;;
  restart) stop_server; start_server ;;
  start|*) start_server ;;
esac