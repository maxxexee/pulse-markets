#!/bin/bash
# Removes the daily epoch build job. Published snapshots and the signing key are
# left untouched.
set -euo pipefail

LABEL="com.pulse.epoch-build"
LOGIN_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
PLIST_PATH="${LOGIN_HOME:-$HOME}/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || echo "job was not loaded"
rm -f "$PLIST_PATH"
echo "removed $LABEL"
