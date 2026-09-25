#!/usr/bin/env bash
# Git-based deploy of music-recommender to homelab.
#
# Flow: push main to origin -> pull on homelab -> rebuild -> health check.
# Requires a clean working tree (commit first). Remote .env is untouched
# because it is git-ignored and never committed.
#
# Database changes use the idempotent additive centered-space guard below.
# Other schema changes must be added to an explicit, tested migration/guard.
# Do not replace it with `drizzle-kit push --force`: an older checkout can
# otherwise remove columns that are present only in the newer schema.
#
# Usage: ./deploy.sh
set -euo pipefail

REMOTE="lab@homelab"
REMOTE_DIR="projects/services/music-recommender"
BRANCH="main"
REMOTE_HEALTH_URL="http://127.0.0.1:4932/api/health"

cd "$(dirname "$0")"

if [ -n "$(git status --porcelain)" ]; then
  echo "ABORT: working tree is dirty - commit first." >&2
  git status --short >&2
  exit 1
fi

echo "==> 1/5 ensuring additive centered-embedding schema (no destructive push)"
bun run db:ensure-centered

echo "==> 2/5 pushing $BRANCH to origin"
git push origin "$BRANCH"

echo "==> 3/5 pulling on homelab"
ssh "$REMOTE" "set -e; cd $REMOTE_DIR && git fetch origin && git checkout $BRANCH --quiet && git pull --ff-only origin $BRANCH && git status --short"

echo "==> 4/5 rebuilding + restarting on homelab (drop retired-service orphans)"
ssh "$REMOTE" "cd $REMOTE_DIR && docker compose up -d --build --remove-orphans"

echo "==> waiting for healthy ($REMOTE_HEALTH_URL)"
ssh "$REMOTE" "
  for i in \$(seq 1 24); do
    if curl -sf $REMOTE_HEALTH_URL >/dev/null; then echo HEALTHY; exit 0; fi
    sleep 5
  done
  echo 'health check FAILED'; docker compose ps; exit 1
"

echo "==> verifying traefik routers"
ssh "$REMOTE" "
  set -e
  for i in \$(seq 1 12); do
    if curl -sf http://127.0.0.1:8080/api/http/routers 2>/dev/null | grep -q 'recommender@docker'; then
      echo 'traefik routers:'; curl -s http://127.0.0.1:8080/api/http/routers | python3 -c \"import json,sys; print([r['name']+':'+r['status'] for r in json.load(sys.stdin) if 'recommender' in r['name']])\"; exit 0
    fi
    sleep 5
  done
  echo 'traefik router for recommender NOT found'; exit 1
"

echo "==> verifying public URL"
PUBLIC_URL="https://$(ssh "$REMOTE" "grep ^DOMAIN= $REMOTE_DIR/.env | cut -d= -f2")"
for i in $(seq 1 12); do
  if curl -sf "$PUBLIC_URL/api/health" >/dev/null; then echo "PUBLIC OK ($PUBLIC_URL)"; exit 0; fi
  sleep 5
done
echo "public check FAILED ($PUBLIC_URL)"; exit 1
