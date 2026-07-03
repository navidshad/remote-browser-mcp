#!/usr/bin/env bash
set -euo pipefail

# ── rbm-chrome-fg.sh ──────────────────────────────────────────────────────────
# FOREGROUND launcher for the dedicated debug Chrome, for pm2 supervision.
#
# Unlike start-chrome-debug.sh (which uses `open -na` and returns immediately),
# this `exec`s the Chrome binary so the pm2-tracked process IS Chrome — pm2 sees
# it exit and relaunches it. Must be exec'd (not `open`ed) or pm2 supervises a
# process that has already detached.
#
# The quoted "$CHROME_BIN" is the whole point: the path contains a space
# ("Google Chrome.app"), which pm2's interpreter:'none' shell-splitting mangles.
# ─────────────────────────────────────────────────────────────────────────────

CDP_PORT="${CDP_PORT:-9222}"
PROFILE_DIR="${RBM_CHROME_PROFILE:-$HOME/.rbm-chrome-debug}"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

exec "$CHROME_BIN" \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run --no-default-browser-check \
  about:blank
