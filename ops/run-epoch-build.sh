#!/bin/bash
# Publishes the PULSE attention index for the previous UTC day.
#
# Written for launchd: no interactive shell, no inherited environment, so the
# node path and every directory are absolute. A build that cannot complete
# publishes nothing and exits non-zero, leaving the previous snapshot in place;
# the retry loop exists because upstreams throttle and a missing day breaks the
# momentum reference for the next seven.
set -euo pipefail

NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../index-service" && pwd)"
LOG_DIR="$SERVICE_DIR/.logs"
LOG_FILE="$LOG_DIR/epoch-build.log"
ATTEMPTS="${ATTEMPTS:-3}"
CATCH_UP_DAYS="${CATCH_UP_DAYS:-7}"
RETRY_SLEEP_SECONDS="${RETRY_SLEEP_SECONDS:-120}"

mkdir -p "$LOG_DIR"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG_FILE"
}

cd "$SERVICE_DIR"

if [ ! -x "$NODE_BIN" ]; then
  log "fatal: node not found at $NODE_BIN"
  exit 1
fi

for attempt in $(seq 1 "$ATTEMPTS"); do
  log "build attempt $attempt/$ATTEMPTS: node src/cli.ts build --catch-up $CATCH_UP_DAYS"
  if "$NODE_BIN" src/cli.ts build --catch-up "$CATCH_UP_DAYS" >>"$LOG_FILE" 2>&1; then
    log "build ok"
    exit 0
  fi
  log "build failed on attempt $attempt"
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$RETRY_SLEEP_SECONDS"
  fi
done

log "build abandoned after $ATTEMPTS attempts; no snapshot replaced"
exit 1
