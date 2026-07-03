#!/usr/bin/env bash
set -euo pipefail

# ── start-chrome-debug.sh ─────────────────────────────────────────────────────
# Launches a DEDICATED debuggable Chrome on a CDP port, as a separate instance so
# your everyday Chrome is untouched.
#
# Why this exists: Chrome 136+ refuses --remote-debugging-port on the DEFAULT
# profile, and the chrome://inspect "channel mode" toggle does NOT expose a port
# that third-party CDP clients (Playwright MCP, the daemon) can use. So CDP-port
# mode with a separate --user-data-dir is the working path.
#
# The profile is PERSISTENT (~/.rbm-chrome-debug by default): log into the sites
# the agent needs ONCE in this window and those logins stick across restarts.
# ─────────────────────────────────────────────────────────────────────────────

CDP_PORT="${CDP_PORT:-9222}"
PROFILE_DIR="${RBM_CHROME_PROFILE:-$HOME/.rbm-chrome-debug}"
CHROME_APP="${CHROME_APP:-/Applications/Google Chrome.app}"
CHROME_BIN="$CHROME_APP/Contents/MacOS/Google Chrome"
START_URL="${RBM_START_URL:-about:blank}"

log()  { echo "▶ $*"; }
die()  { echo "✗  $*" >&2; exit 1; }

[[ -x "$CHROME_BIN" ]] || die "Google Chrome not found at: $CHROME_BIN (set CHROME_APP to override)."

if curl -sf "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  log "Debug Chrome already up on port ${CDP_PORT} — nothing to do."
  curl -s "http://localhost:${CDP_PORT}/json/version" | python3 -c 'import sys,json;print("  "+json.load(sys.stdin).get("Browser",""))' 2>/dev/null || true
  exit 0
fi

mkdir -p "$PROFILE_DIR"
log "Launching dedicated debug Chrome:"
log "  port    : ${CDP_PORT}"
log "  profile : ${PROFILE_DIR}  (persistent; logins stick here)"

# `open -na` starts a SECOND Chrome instance independent of your normal one.
open -na "$CHROME_APP" --args \
  --remote-debugging-port="${CDP_PORT}" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run --no-default-browser-check \
  "$START_URL"

# Wait for the CDP endpoint to come up.
for _ in $(seq 1 10); do
  if curl -sf "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    log "CDP endpoint is up ✓  ($(curl -s "http://localhost:${CDP_PORT}/json/version" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("Browser",""))' 2>/dev/null))"
    log "First time? Log into the sites the agent should use in THIS window."
    exit 0
  fi
  sleep 2
done
die "CDP port ${CDP_PORT} never came up. Is another Chrome already bound to it, or is the profile dir locked?"
