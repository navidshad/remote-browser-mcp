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

# How Playwright MCP attaches to Chrome:
#   extension (default) — via the "Playwright MCP Bridge" Chrome extension, in your
#                         REAL profile (real logins). No flags, no debug profile.
#   cdp                 — legacy CDP-port mode: a dedicated debug Chrome on :9222
#                         (separate profile; see scripts/start-chrome-debug.sh).
BROWSER_MODE="${BROWSER_MODE:-extension}"

# Local secrets (e.g. PLAYWRIGHT_MCP_EXTENSION_TOKEN) — gitignored, never committed.
# The token lets --extension auto-connect to a specific Chrome profile with no dialog.
[[ -f "$SCRIPT_DIR/.rbm-env" ]] && source "$SCRIPT_DIR/.rbm-env"

log()  { echo "▶ $*"; }
warn() { echo "⚠  $*"; }
die()  { echo "✗  $*" >&2; exit 1; }

# ── Prerequisite checks ───────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || die "Node.js is not installed."
command -v npx  >/dev/null 2>&1 || die "npx is not installed."

# Guard against an old default Node (this machine's login shell defaults to an
# nvm Node 14, which silently crashes the daemon on `??=` and breaks npx). The
# daemon and @playwright/mcp need Node 20+. Fail fast with a clear fix instead.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  die "Node $(node --version) is too old (need >=20). Run with a modern Node, e.g.:
       export PATH=\"\$HOME/.nvm/versions/node/v22.17.1/bin:\$PATH\"   # or: nvm use 22
       then re-run this script."
fi

if [[ "$BROWSER_MODE" == "cdp" ]]; then
  log "Browser mode: cdp — checking Chrome on port ${CDP_PORT}..."
  if curl -sf "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    log "Chrome is running and CDP port ${CDP_PORT} is accessible ✓"
  else
    warn "Chrome CDP port ${CDP_PORT} not accessible. Launch the debug Chrome first:"
    warn "  make chrome-debug   (or: bash scripts/start-chrome-debug.sh)"
  fi
else
  log "Browser mode: extension — Playwright MCP attaches to your real Chrome via the"
  log "'Playwright MCP Bridge' extension."
  if [[ -n "${PLAYWRIGHT_MCP_EXTENSION_TOKEN:-}" ]]; then
    log "  Extension token: set ✓ (auto-connects to the paired profile, no dialog)"
  else
    warn "  Extension token: NOT set — you'll have to approve the connection in the"
    warn "  browser each run. Put PLAYWRIGHT_MCP_EXTENSION_TOKEN in scripts/.rbm-env"
    warn "  (copy it from the extension's status page) for unattended connect."
  fi
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
# so requests arriving through the tunnel get a 403 on the Host check.
# With a named tunnel (stable hostnames) we pin the check to those hostnames,
# plus localhost for on-machine smoke tests. Without one (quick tunnels, whose
# URL changes every start) we allow all hosts and rely on the authenticated
# tunnel as the security boundary (PRD §14). Override with PLAYWRIGHT_ALLOWED_HOSTS.
TUNNEL_CONFIG="${TUNNEL_CONFIG:-$HOME/.cloudflared/remote-browser.yml}"
if [[ -z "${PLAYWRIGHT_ALLOWED_HOSTS:-}" && -f "$TUNNEL_CONFIG" ]]; then
  TUNNEL_HOSTS="$(grep -oE 'hostname: *[^ ]+' "$TUNNEL_CONFIG" | awk '{print $2}' | paste -sd, -)"
  PLAYWRIGHT_ALLOWED_HOSTS="${TUNNEL_HOSTS},localhost,localhost:${PLAYWRIGHT_PORT},127.0.0.1,127.0.0.1:${PLAYWRIGHT_PORT}"
fi
PLAYWRIGHT_ALLOWED_HOSTS="${PLAYWRIGHT_ALLOWED_HOSTS:-*}"
log "  Allowed hosts: ${PLAYWRIGHT_ALLOWED_HOSTS}"
if [[ "$BROWSER_MODE" == "cdp" ]]; then
  PW_BROWSER_ARGS=(--browser chrome --cdp-endpoint "http://localhost:${CDP_PORT}")
else
  PW_BROWSER_ARGS=(--extension)
fi
npx --yes @playwright/mcp@latest \
  --port "$PLAYWRIGHT_PORT" \
  "${PW_BROWSER_ARGS[@]}" \
  --allowed-hosts "$PLAYWRIGHT_ALLOWED_HOSTS" \
  &
PLAYWRIGHT_PID=$!
log "  Playwright MCP PID: ${PLAYWRIGHT_PID}"

# In extension mode the agent's profile must have a window OPEN (background is fine)
# or the bridge extension isn't loaded and connections time out. Ensure one exists.
# Disable with AUTO_OPEN_ASO=0.
if [[ "$BROWSER_MODE" != "cdp" && "${AUTO_OPEN_ASO:-1}" == "1" && "$(uname)" == "Darwin" ]]; then
  bash "$SCRIPT_DIR/open-aso-window.sh" || warn "Could not auto-open the agent Chrome window — open it yourself."
fi

# ── Start Daemon ──────────────────────────────────────────────────────────────

log "Starting Remote Browser Daemon on port ${DAEMON_PORT}..."
cd "$ROOT"
# BROWSER_MODE + PLAYWRIGHT_PORT let the daemon's presence check (check_local_status)
# probe the right thing: the Playwright MCP bridge in extension mode, the CDP port otherwise.
PORT="$DAEMON_PORT" CDP_PORT="$CDP_PORT" BROWSER_MODE="$BROWSER_MODE" PLAYWRIGHT_PORT="$PLAYWRIGHT_PORT" \
  node packages/daemon/dist/index.js &
DAEMON_PID=$!
log "  Daemon PID: ${DAEMON_PID}"

sleep 1

# ── Tunnel setup ─────────────────────────────────────────────────────────────

if command -v cloudflared >/dev/null 2>&1; then
  if [[ -f "$TUNNEL_CONFIG" ]]; then
    # Named tunnel: stable hostnames, one process, two ingress rules.
    # One-time setup + how to undo it: SETUP-LOG.md.
    log "Starting named Cloudflare tunnel (${TUNNEL_CONFIG})..."
    cloudflared tunnel --config "$TUNNEL_CONFIG" run &
    TUNNEL_PID=$!
    log "  Tunnel PID: ${TUNNEL_PID}"
    log "  Public hostnames: $(grep -oE 'hostname: *[^ ]+' "$TUNNEL_CONFIG" | awk '{print $2}' | paste -sd, -)"
  else
    log "Starting Cloudflare quick tunnels (no named tunnel config at ${TUNNEL_CONFIG})..."

    cloudflared tunnel --url "http://localhost:${PLAYWRIGHT_PORT}" --no-autoupdate &
    TUNNEL_PW_PID=$!

    cloudflared tunnel --url "http://localhost:${DAEMON_PORT}" --no-autoupdate &
    TUNNEL_DAEMON_PID=$!

    log "  Playwright tunnel PID: ${TUNNEL_PW_PID}"
    log "  Daemon tunnel PID:     ${TUNNEL_DAEMON_PID}"
    log ""
    log "Watch the cloudflared output above for the public URLs (trycloudflare.com)."
    log "Set those as PLAYWRIGHT_URL and DAEMON_URL in your .env or docker-compose."
  fi
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
  kill "${TUNNEL_PID:-0}"        2>/dev/null || true
  kill "${TUNNEL_PW_PID:-0}"    2>/dev/null || true
  kill "${TUNNEL_DAEMON_PID:-0}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

log ""
log "All services started. Press Ctrl+C to stop."
wait
