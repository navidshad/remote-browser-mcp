#!/usr/bin/env bash
set -euo pipefail

# ── start-local.sh ────────────────────────────────────────────────────────────
# Starts all host-side services for Remote Browser MCP:
#   1. Checks Chrome is running with remote debugging
#   2. Playwright MCP  (port 3000)
#   3. Remote Browser Daemon  (port 3001)
#   4. Cloudflare tunnels for each service (if cloudflared is available)
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

PLAYWRIGHT_PORT="${PLAYWRIGHT_PORT:-3000}"
DAEMON_PORT="${DAEMON_PORT:-3001}"
CDP_PORT="${CDP_PORT:-9222}"

log()  { echo "▶ $*"; }
warn() { echo "⚠  $*"; }
die()  { echo "✗  $*" >&2; exit 1; }

# ── Prerequisite checks ───────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || die "Node.js is not installed."
command -v npx  >/dev/null 2>&1 || die "npx is not installed."

log "Checking Chrome..."
if curl -sf "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  log "Chrome is running and CDP port ${CDP_PORT} is accessible ✓"
else
  warn "Chrome CDP port ${CDP_PORT} not accessible."
  warn "If you are using channel mode, that is expected — Chrome does not open a TCP port."
  warn "If you want CDP port mode, launch Chrome with:"
  warn "  open -a 'Google Chrome' --args --remote-debugging-port=${CDP_PORT} --user-data-dir=/tmp/chrome-debug"
  warn "For channel mode, make sure you visited chrome://inspect/#remote-debugging and enabled it."
fi

# ── Kill existing processes on the ports (dev convenience) ────────────────────

kill_port() {
  local port=$1
  local pid
  pid=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [[ -n "$pid" ]]; then
    log "Freeing port $port (pid $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 0.5
  fi
}

kill_port "$PLAYWRIGHT_PORT"
kill_port "$DAEMON_PORT"

# ── Start Playwright MCP ──────────────────────────────────────────────────────

log "Starting Playwright MCP on port ${PLAYWRIGHT_PORT}..."
# --allowed-hosts: by default Playwright MCP only serves the bound host (localhost),
# so requests arriving through the tunnel (Host: *.trycloudflare.com) get a 403.
# The free tunnel URL changes on each restart, so we allow all hosts and rely on
# the authenticated tunnel as the security boundary (PRD §14). Override with
# PLAYWRIGHT_ALLOWED_HOSTS to pin a specific host.
PLAYWRIGHT_ALLOWED_HOSTS="${PLAYWRIGHT_ALLOWED_HOSTS:-*}"
npx --yes @playwright/mcp@latest \
  --port "$PLAYWRIGHT_PORT" \
  --browser chrome \
  --cdp-endpoint "http://localhost:${CDP_PORT}" \
  --allowed-hosts "$PLAYWRIGHT_ALLOWED_HOSTS" \
  &
PLAYWRIGHT_PID=$!
log "  Playwright MCP PID: ${PLAYWRIGHT_PID}"

# ── Start Daemon ──────────────────────────────────────────────────────────────

log "Starting Remote Browser Daemon on port ${DAEMON_PORT}..."
cd "$ROOT"
PORT="$DAEMON_PORT" CDP_PORT="$CDP_PORT" node packages/daemon/dist/index.js &
DAEMON_PID=$!
log "  Daemon PID: ${DAEMON_PID}"

sleep 1

# ── Tunnel setup ─────────────────────────────────────────────────────────────

if command -v cloudflared >/dev/null 2>&1; then
  log "Starting Cloudflare Tunnels..."

  cloudflared tunnel --url "http://localhost:${PLAYWRIGHT_PORT}" --no-autoupdate &
  TUNNEL_PW_PID=$!

  cloudflared tunnel --url "http://localhost:${DAEMON_PORT}" --no-autoupdate &
  TUNNEL_DAEMON_PID=$!

  log "  Playwright tunnel PID: ${TUNNEL_PW_PID}"
  log "  Daemon tunnel PID:     ${TUNNEL_DAEMON_PID}"
  log ""
  log "Watch the cloudflared output above for the public URLs (trycloudflare.com)."
  log "Set those as PLAYWRIGHT_URL and DAEMON_URL in your .env or docker-compose."
else
  warn "cloudflared not found — skipping tunnel setup."
  warn "Install with: brew install cloudflare/cloudflare/cloudflared"
  warn ""
  warn "For M1 (local testing), you can reach the services directly:"
  warn "  PLAYWRIGHT_URL=http://localhost:${PLAYWRIGHT_PORT}"
  warn "  DAEMON_URL=http://localhost:${DAEMON_PORT}/mcp"
fi

# ── Trap cleanup ──────────────────────────────────────────────────────────────

cleanup() {
  log "Shutting down..."
  kill "$PLAYWRIGHT_PID" 2>/dev/null || true
  kill "$DAEMON_PID"     2>/dev/null || true
  kill "${TUNNEL_PW_PID:-0}"    2>/dev/null || true
  kill "${TUNNEL_DAEMON_PID:-0}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

log ""
log "All services started. Press Ctrl+C to stop."
wait
