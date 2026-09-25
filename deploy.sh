#!/usr/bin/env bash
# Deploy the checked-out repository on the machine running this script.
# The script never pushes commits or connects to another host over SSH.
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4932/api/health}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v git >/dev/null || die "git is not installed"
command -v docker >/dev/null || die "docker is not installed"
command -v curl >/dev/null || die "curl is not installed"
command -v bun >/dev/null || die "bun is not installed"
[ -f .env ] || die ".env is missing; copy .env.example and configure it first"
[ -f "$COMPOSE_FILE" ] || die "Compose file not found: $COMPOSE_FILE"

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is not clean; commit or stash local changes first." >&2
  git status --short >&2
  exit 1
fi

echo "==> Fetching $BRANCH"
git fetch origin "$BRANCH"

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
else
  git checkout -b "$BRANCH" "origin/$BRANCH"
fi

echo "==> Updating the local checkout"
git pull --ff-only origin "$BRANCH"

echo "==> Ensuring additive centered-embedding schema"
bun run db:ensure-centered

echo "==> Validating Compose configuration"
docker compose -f "$COMPOSE_FILE" config --quiet

echo "==> Rebuilding and restarting the local stack"
if ! docker compose -f "$COMPOSE_FILE" up -d --build --remove-orphans --wait; then
  docker compose -f "$COMPOSE_FILE" ps || true
  docker compose -f "$COMPOSE_FILE" logs --tail=100 || true
  die "Docker Compose deployment failed"
fi

echo "==> Checking $HEALTH_URL"
for _ in $(seq 1 24); do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    echo "Deployment complete; local health check passed."
    exit 0
  fi
  sleep 5
done

docker compose -f "$COMPOSE_FILE" ps || true
die "local health check failed: $HEALTH_URL"
