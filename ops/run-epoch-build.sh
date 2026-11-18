#!/bin/bash
# Publishes the PULSE attention index for the previous UTC day.
#
# Written for launchd: no interactive shell, no inherited environment, so the
# node path and every directory are absolute. A build that cannot complete
# publishes nothing and exits non-zero, leaving the previous snapshot in place;
# the retry loop exists because upstreams throttle, and because a build that
# runs before a source has posted its daily figure is refused, so the retries are
# spaced by a quarter of an hour rather than by seconds.
set -euo pipefail

NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="$REPO_DIR/index-service"
LOG_DIR="$SERVICE_DIR/.logs"
LOG_FILE="$LOG_DIR/epoch-build.log"
ATTEMPTS="${ATTEMPTS:-3}"
CATCH_UP_DAYS="${CATCH_UP_DAYS:-7}"
RETRY_SLEEP_SECONDS="${RETRY_SLEEP_SECONDS:-900}"

mkdir -p "$LOG_DIR"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG_FILE"
}

cd "$SERVICE_DIR"

# launchd starts this job with no environment. Trend context is written during
# the build, so its key is read from an ignored file beside the service.
if [ -f "$SERVICE_DIR/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$SERVICE_DIR/.env.local"
  set +a
fi

if [ ! -x "$NODE_BIN" ]; then
  log "fatal: node not found at $NODE_BIN"
  exit 1
fi

for attempt in $(seq 1 "$ATTEMPTS"); do
  log "build attempt $attempt/$ATTEMPTS: node src/cli.ts build --catch-up $CATCH_UP_DAYS"
  if "$NODE_BIN" src/cli.ts build --catch-up "$CATCH_UP_DAYS" >>"$LOG_FILE" 2>&1; then
    log "build ok"
    # A source can revise its figures after a day was signed. Verifying here
    # records whether today's sources still reproduce the newest epoch, without
    # failing the job: a revision is information, not a build failure.
    if [ "${VERIFY_ON_BUILD:-1}" = "1" ]; then
      if "$NODE_BIN" src/cli.ts verify >>"$LOG_FILE" 2>&1; then
        log "verify ok"
      else
        log "verify reported a difference; see the verify lines above"
      fi
    fi
    if [ "${DEPLOY_ON_BUILD:-1}" = "1" ]; then
      "$REPO_DIR/ops/deploy-pages.sh" >>"$LOG_FILE" 2>&1 && log "site deployed" || log "site deploy failed"
    fi
    exit 0
  fi
  log "build failed on attempt $attempt"
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$RETRY_SLEEP_SECONDS"
  fi
done

log "build abandoned after $ATTEMPTS attempts; no snapshot replaced"
exit 1
