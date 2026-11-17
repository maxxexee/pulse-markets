#!/bin/bash
# Installs the daily epoch build as a per-user launchd job.
#
# The slot is given in UTC because epochs are UTC days; launchd schedules in
# local time, so the local equivalent is computed here and printed. Re-running
# replaces the job, which is also how a changed slot is applied.
set -euo pipefail

UTC_HOUR="${1:-9}"
UTC_MINUTE="${2:-15}"
LABEL="com.pulse.epoch-build"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="$REPO_DIR/index-service"
RUNNER="$REPO_DIR/ops/run-epoch-build.sh"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
LOG_DIR="$SERVICE_DIR/.logs"
# The login home, not $HOME: this session's HOME can be a tool-specific profile,
# and a plist outside the real ~/Library/LaunchAgents is not reloaded at login.
LOGIN_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
PLIST_DIR="${LOGIN_HOME:-$HOME}/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"

if [ ! -x "$NODE_BIN" ]; then
  echo "node not found; set NODE_BIN to an absolute path" >&2
  exit 1
fi
if [ ! -x "$RUNNER" ]; then
  echo "runner is not executable: $RUNNER" >&2
  exit 1
fi
mkdir -p "$LOG_DIR" "$PLIST_DIR"

read -r LOCAL_HOUR LOCAL_MINUTE LOCAL_ZONE <<<"$(
  UTC_HOUR="$UTC_HOUR" UTC_MINUTE="$UTC_MINUTE" python3 - <<'PY'
import os
from datetime import datetime, timezone

hour = int(os.environ["UTC_HOUR"])
minute = int(os.environ["UTC_MINUTE"])
slot = datetime.now(timezone.utc).replace(hour=hour, minute=minute, second=0, microsecond=0)
local = slot.astimezone()
print(local.hour, local.minute, local.strftime("%Z%z"))
PY
)"

sed \
  -e "s|__RUNNER__|$RUNNER|" \
  -e "s|__NODE_BIN__|$NODE_BIN|" \
  -e "s|__SERVICE_DIR__|$SERVICE_DIR|" \
  -e "s|__LOG_DIR__|$LOG_DIR|" \
  -e "s|__HOUR__|$LOCAL_HOUR|" \
  -e "s|__MINUTE__|$LOCAL_MINUTE|" \
  "$REPO_DIR/ops/$LABEL.plist.template" >"$PLIST_PATH"

plutil -lint "$PLIST_PATH" >/dev/null

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST_PATH"
launchctl enable "gui/$UID/$LABEL"

echo "installed $LABEL"
echo "  utc slot      $UTC_HOUR:$UTC_MINUTE"
echo "  local slot    $LOCAL_HOUR:$LOCAL_MINUTE ($LOCAL_ZONE)"
echo "  plist         $PLIST_PATH"
echo "  runner        $RUNNER"
echo "  log           $LOG_DIR/epoch-build.log"
echo "  node          $NODE_BIN"
echo
echo "verify with: launchctl kickstart -k gui/$UID/$LABEL && tail -f $LOG_DIR/epoch-build.log"
