#!/usr/bin/env bash
set -uo pipefail

# ── rbm-chrome-guard.sh ───────────────────────────────────────────────────────
# Watchdog that keeps the debug Chrome on :9222 driveable.
#
# Playwright-over-CDP throws "Browser context management is not supported" when a
# session attaches and finds ZERO page targets (e.g. the agent closed the last
# tab). pm2 keeps the Chrome *process* alive but can't see an empty-tab browser,
# so it never recovers on its own. This loop notices count==0 and opens a fresh
# about:blank tab (Chrome 136+ requires PUT on /json/new), so the next agent
# session always has a page to drive.
#
# Runs under pm2 as `rbm-chrome-guard` (see ecosystem.config.cjs). No -e: a
# transient curl failure must not kill the loop.
# ─────────────────────────────────────────────────────────────────────────────

CDP_PORT="${CDP_PORT:-9222}"
INTERVAL="${RBM_GUARD_INTERVAL:-15}"
BASE="http://localhost:${CDP_PORT}"

log() { echo "[rbm-chrome-guard] $*"; }

# Page-type target count. Echoes -1 when the endpoint is unreachable/unparseable,
# so a transient failure never looks like "0 tabs" and triggers a needless open.
page_count() {
  curl -sf "${BASE}/json/list" 2>/dev/null | python3 -c '
import sys, json
try:
    print(sum(1 for x in json.load(sys.stdin) if x.get("type") == "page"))
except Exception:
    print(-1)
' 2>/dev/null || echo -1
}

log "started (interval ${INTERVAL}s, port ${CDP_PORT})"
while true; do
  n="$(page_count)"
  if [[ "$n" == "0" ]]; then
    log "0 page targets — opening a blank tab"
    if curl -sf -X PUT "${BASE}/json/new?about:blank" >/dev/null 2>&1; then
      log "blank tab opened"
    else
      log "failed to open tab (CDP may be mid-restart)"
    fi
  fi
  sleep "$INTERVAL"
done
