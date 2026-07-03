#!/usr/bin/env bash
set -euo pipefail

# ── open-aso-window.sh ────────────────────────────────────────────────────────
# Ensure the agent's Chrome profile has a window OPEN, so the Playwright MCP Bridge
# extension's background worker is alive and the VM agent can attach. The window may
# sit in the background — focus is NOT required; it just has to exist. (If the profile
# has no window, the extension isn't loaded and connections fall through / time out.)
#
# The profile is named by DISPLAY NAME (ASO_PROFILE_NAME) and resolved to its
# "Profile N" directory via Chrome's Local State — never hardcode the number.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/.rbm-env" ]] && source "$SCRIPT_DIR/.rbm-env"

ASO_PROFILE_NAME="${ASO_PROFILE_NAME:-Aso Dara}"
CHROME_DIR="${CHROME_DIR:-$HOME/Library/Application Support/Google/Chrome}"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
EXT_ID="mmlmfjhmonkocbjadbfplnigmagldckm"   # Playwright MCP Bridge

log()  { echo "▶ $*"; }
die()  { echo "✗  $*" >&2; exit 1; }

[[ -x "$CHROME_BIN" ]] || die "Google Chrome not found at: $CHROME_BIN (set CHROME_BIN)."
[[ -f "$CHROME_DIR/Local State" ]] || die "Chrome Local State not found under: $CHROME_DIR"

# Resolve display name -> profile directory.
PROFILE_DIR="$(python3 - "$ASO_PROFILE_NAME" <<PY
import json, os, sys
name = sys.argv[1]
ls = json.load(open(os.path.expanduser("$CHROME_DIR/Local State")))
for d, info in ls.get("profile", {}).get("info_cache", {}).items():
    if info.get("name") == name:
        print(d); break
PY
)"
[[ -n "$PROFILE_DIR" ]] || die "No Chrome profile named '$ASO_PROFILE_NAME' found in Local State."
log "Agent profile '$ASO_PROFILE_NAME' = '$PROFILE_DIR'"

# Safety: the bridge extension must be installed ONLY in this profile.
others="$(ls -d "$CHROME_DIR"/*/Extensions/"$EXT_ID" 2>/dev/null | sed "s|$CHROME_DIR/||;s|/Extensions/.*||" | grep -vx "$PROFILE_DIR" || true)"
if [[ -n "$others" ]]; then
  echo "⚠  WARNING: the bridge extension is ALSO in: $others"
  echo "⚠  That breaks isolation — remove it from those profiles (chrome://extensions)."
fi
[[ -d "$CHROME_DIR/$PROFILE_DIR/Extensions/$EXT_ID" ]] || \
  echo "⚠  The bridge extension is NOT in '$ASO_PROFILE_NAME' — install it there first."

# Open a window for the profile (background is fine). about:blank guarantees a usable
# page target so the first browser command doesn't hit "0 page targets".
"$CHROME_BIN" --profile-directory="$PROFILE_DIR" about:blank >/dev/null 2>&1 &
log "Opened a window for '$ASO_PROFILE_NAME'. Keep it open (background OK) while the agent may browse."
