#!/bin/bash
# Publishes the exported site to this repo's gh-pages branch.
#
# The index is built and signed on this machine, so the site is a snapshot of
# disk state at deploy time, not a live server: run this after a build (or from
# the same job) and the page reflects whatever was published then. The branch is
# replaced on every deploy, because the site is generated output and history
# there has no value.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="$REPO_DIR/index-service"
SITE_DIR="$SERVICE_DIR/.site"
BRANCH="gh-pages"
REMOTE="$(git -C "$REPO_DIR" remote get-url origin)"

rm -rf "$SITE_DIR"
(cd "$SERVICE_DIR" && node src/cli.ts export --out "$SITE_DIR")

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -R "$SITE_DIR"/. "$WORK"/
# Jekyll would otherwise rewrite paths and drop files it does not understand.
: >"$WORK/.nojekyll"

git -C "$WORK" init -q -b "$BRANCH"
git -C "$WORK" add -A
git -C "$WORK" -c user.name="$(git -C "$REPO_DIR" config user.name)" \
  -c user.email="$(git -C "$REPO_DIR" config user.email)" \
  commit -q -m "Publish index site for $(date -u '+%Y-%m-%dT%H:%MZ')"
git -C "$WORK" remote add origin "$REMOTE"
git -C "$WORK" push -q -f origin "$BRANCH"

OWNER_AND_REPO="${REMOTE%.git}"
OWNER_AND_REPO="${OWNER_AND_REPO#*github.com}"
OWNER_AND_REPO="${OWNER_AND_REPO#[:/]}"
OWNER="${OWNER_AND_REPO%%/*}"
REPO="${OWNER_AND_REPO#*/}"

echo "pushed $(find "$SITE_DIR" -type f | wc -l | tr -d ' ') files to $BRANCH on $REMOTE"
echo "site: https://$OWNER.github.io/$REPO/"
