#!/usr/bin/env bash
#
# Sole first run.
#
# Nothing to configure and nothing to clone: this downloads the compose files,
# writes a .env with fresh secrets, pulls the published images, applies the
# schema, and creates an admin account. Run it from the folder you want the
# install to live in.
#
#   curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/setup.sh | bash
#
# Docker is the only requirement. Passing a music folder skips the one prompt:
#
#   curl -fsSL .../setup.sh | bash -s /path/to/music
#
set -euo pipefail

REPO="${SOLE_REPO:-poesterlin/sole}"
RAW="https://raw.githubusercontent.com/${REPO}/${SOLE_VERSION:-v0.1.3}"
STACK_FILE="stack.yaml"
COMPOSE_FILE="compose.yaml"
EXAMPLE_FILE=".env.example"
ENV_FILE=".env"

# .env.example documents every setting, including placeholder hosts. A fresh
# install must not point at those, so an installer leaves them empty. Blanking
# an absent key costs nothing.
BLANKED=(
  "MUSIC_HOST"
  "MA_TOKEN"
  "PLAYBACK_API_KEY"
)

die() {
  printf '\n%s\n\n' "$1" >&2
  exit 1
}

note() { printf '%s\n' "$1"; }

# Reads one answer from the terminal. Falls back to the default when there is
# no terminal, which keeps `curl | bash` working and makes CI runs non-blocking.
ask() {
  local label="$1" default="$2" answer=""
  if [ -e /dev/tty ] && [ -r /dev/tty ]; then
    printf '%s [%s]: ' "$label" "$default" >/dev/tty || true
    IFS= read -r answer </dev/tty || answer=""
  fi
  printf '%s' "${answer:-$default}"
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '='
  else
    head -c "$1" /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
  fi
}

command -v docker >/dev/null 2>&1 ||
  die "Docker is required. Install it from https://docs.docker.com/get-docker/ and run this again."
docker compose version >/dev/null 2>&1 ||
  die "Docker Compose v2 is required. Update Docker so \`docker compose version\` works."
command -v curl >/dev/null 2>&1 || die "curl is required to download the compose files."

note "Sole setup. Press Enter to accept each default."

if [ -e "$ENV_FILE" ]; then
  printf '\nAn %s already exists, so this is not a first run.\n\n' "$ENV_FILE"
   printf 'To start or update:\n\n  docker compose -f stack.yaml up -d\n\n'
   printf 'See the local-install guide for changing the music volume or enabling the worker.\n'
  exit 0
fi

if [ "$#" -gt 0 ]; then
  library="$1"
else
  library="$(ask "Folder that contains your music (read-only)" "${HOME}/Music")"
fi
case "$library" in
  "~/"*) library="${HOME}/${library#\~/}" ;;
esac
library="${library%/}"

if [ ! -d "$library" ]; then
  note ""
  die "Music folder does not exist: $library. Create it or provide the correct path."
fi

if [ ! -e "$STACK_FILE" ]; then
  note ""
  note "Downloading ${STACK_FILE} and ${COMPOSE_FILE} ..."
  for file in "$STACK_FILE" "$COMPOSE_FILE"; do
    curl -fsSL "${RAW}/${file}" -o "$file" || die "Could not download ${file}."
    [ -s "$file" ] || die "Downloaded ${file} was empty."
  done
fi

example=""
if curl -fsSL "${RAW}/${EXAMPLE_FILE}" -o "${EXAMPLE_FILE}.download" 2>/dev/null; then
  example="${EXAMPLE_FILE}.download"
elif [ -e "$EXAMPLE_FILE" ]; then
  example="$EXAMPLE_FILE"
fi

password="$(random_hex 24)"
worker_token="$(random_hex 24)"
admin_password="$(random_token 12)"

database_url="postgres://sole:${password}@127.0.0.1:5432/sole"
database_internal_url="postgres://sole:${password}@postgres:5432/sole"

declare -A settings=(
  [DOMAIN]="localhost"
  [ORIGIN]="http://127.0.0.1:3000"
  [MUSIC_LIBRARY_PATH]="$library"
  [POSTGRES_PASSWORD]="$password"
  [DATABASE_URL]="$database_url"
  [DATABASE_INTERNAL_URL]="$database_internal_url"
  [WORKER_TOKEN]="$worker_token"
)
declare -A blanked=()
for key in "${BLANKED[@]}"; do blanked["$key"]=1; done

{
  declare -A seen=()
  if [ -n "$example" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        [A-Z_]*=*)
          key="${line%%=*}"
          seen["$key"]=1
          if [ -n "${settings[$key]+set}" ]; then
            printf '%s=%s\n' "$key" "${settings[$key]}"
            continue
          fi
          if [ -n "${blanked[$key]+set}" ]; then
            printf '%s=\n' "$key"
            continue
          fi
          ;;
      esac
      printf '%s\n' "$line"
    done <"$example"
  fi

  # Any setting the example file does not document is appended once. PostgreSQL
  # is deliberately not published: nothing outside the stack needs it, and a
  # host that already runs PostgreSQL would otherwise collide on 5432.
  for key in "${!settings[@]}"; do
    [ -n "${seen[$key]+set}" ] || printf '%s=%s\n' "$key" "${settings[$key]}"
  done
} >"$ENV_FILE"

# The file holds generated secrets.
chmod 600 "$ENV_FILE" 2>/dev/null || true
rm -f "${EXAMPLE_FILE}.download"

note "Wrote ${ENV_FILE} with a generated database password."
note "Your music folder is mounted read-only into the app."

compose=(docker compose -f "$STACK_FILE" --env-file "$ENV_FILE")

note ""
note "Starting PostgreSQL ..."
"${compose[@]}" up -d --wait postgres ||
  die "Startup failed. Check the output above, then rerun \`docker compose -f stack.yaml up -d\`."

note ""
note "Applying the schema ..."
"${compose[@]}" run --rm --entrypoint sh web \
  -c 'bun scripts/ensure-pgvector.ts && bunx drizzle-kit migrate' ||
  die "The schema step failed. Rerun: docker compose -f stack.yaml run --rm --entrypoint sh web -c 'bun scripts/ensure-pgvector.ts && bunx drizzle-kit migrate'"

note ""
note "Creating the admin account ..."
"${compose[@]}" run --rm --entrypoint bun web \
  web/scripts/create-user.ts --username admin --password "$admin_password" >/dev/null ||
  die "Could not create the account. Run: docker compose -f stack.yaml run --rm --entrypoint bun web web/scripts/create-user.ts --username admin"

note "Starting the app ..."
"${compose[@]}" up -d --wait web || die "App startup failed. Check docker compose -f stack.yaml logs web."

cat <<EOF

Ready.

  Open      http://127.0.0.1:3000/login
  Username  admin
  Password  ${admin_password}

  Music     ${library}
  Settings  ${ENV_FILE}

Add your Music Assistant details to ${ENV_FILE}, then run:
  docker compose -f stack.yaml up -d

Enable automatic embedding after indexing your library:
  docker compose -f stack.yaml --profile embedding up -d worker

See the local-install guide for changing ports or the music volume.
EOF
