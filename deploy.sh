#!/usr/bin/env bash
# Git-based deploy of music-recommender to homelab.
#
# Flow: push main to origin -> pull on homelab -> rebuild -> health check.
# Requires a clean working tree (commit first). Remote .env is untouched
# because it is git-ignored and never committed.
#
# Usage: ./deploy.sh
set -euo pipefail

REMOTE="lab@homelab"
REMOTE_DIR="projects/services/music-recommender"
BRANCH="main"
REMOTE_HEALTH_URL="http://127.0.0.1:4932/api/status"

cd "$(dirname "$0")"

if [ -n "$(git status --porcelain)" ]; then
  echo "ABORT: working tree is dirty - commit first." >&2
  git status --short >&2
  exit 1
fi

echo "==> 1/4 DB migrations (drizzle push, uses local .env DATABASE_URL)"
bunx drizzle-kit push --force

echo "==> 2/4 pushing $BRANCH to origin"
git push origin "$BRANCH"

echo "==> 3/4 pulling on homelab"
ssh "$REMOTE" "set -e; cd $REMOTE_DIR && git fetch origin && git checkout $BRANCH --quiet && git pull --ff-only origin $BRANCH && git status --short"

echo "==> 4/4 rebuild + restart on homelab"
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose up -d --build"

echo "==> waiting for healthy ($REMOTE_HEALTH_URL)"
ssh "$REMOTE" "
  for i in \$(seq 1 24); do
    if curl -sf $REMOTE_HEALTH_URL >/dev/null; then echo HEALTHY; exit 0; fi
    sleep 5
  done
  echo 'health check FAILED'; docker compose ps; exit 1
"
