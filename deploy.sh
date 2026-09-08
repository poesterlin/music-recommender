#!/usr/bin/env bash
# Deploy music-recommender to homelab.
#
# What it does:
#   1. Applies DB migrations (the DB is shared - local .env and homelab .env
#      point at the same postgres, so migrating from here is enough).
#   2. Rsyncs the working tree to lab@homelab:projects/services/music-recommender.
#      The remote .env is NEVER touched (excluded from rsync).
#   3. Rebuilds and restarts via docker compose, then polls /api/status.
#
# Usage: ./deploy.sh
set -euo pipefail

REMOTE="lab@homelab"
REMOTE_DIR="projects/services/music-recommender"
REMOTE_HEALTH_URL="http://127.0.0.1:4932/api/status"

cd "$(dirname "$0")"

echo "==> 1/4 DB migrations (drizzle push, uses local .env DATABASE_URL)"
bunx drizzle-kit push --force

echo "==> 2/4 remote state before sync (informational - rsync wins)"
ssh "$REMOTE" "cd $REMOTE_DIR && git status --short | head -20 || true"

echo "==> 3/4 rsync to $REMOTE:$REMOTE_DIR (remote .env excluded)"
rsync -avz --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.env*' \
  --exclude='output/' \
  --exclude='.ruff_cache/' \
  --exclude='nohup.out' \
  --exclude='*.csv' \
  ./ "$REMOTE:$REMOTE_DIR/"

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
