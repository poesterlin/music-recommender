# Local install

Docker is the only requirement. Every step is an explicit command you can read before it runs — nothing is piped from a URL into a shell.

## 1. Get the files

```sh
mkdir sole && cd sole
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/stack.yaml -o compose.yaml
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/.env.example -o .env.example
```

`compose.yaml` describes the stack: PostgreSQL, the app, and an optional worker. `.env.example` is the reference list of every setting; you read it, you do not edit it. The whole stack is short, and you can expand it here rather than open the file:

::: details The compose stack you are about to run

```yaml
# Minimal first-run stack: published images only, no clone required.
#
# The setup script writes this next to a .env and starts it. It is deliberately
# small: PostgreSQL, the app, and an optional API-mode worker. The repository's
# compose.yaml adds the clustering profiles and the Traefik labels for a public
# deployment. (The maintenance jobs run inside the app in either stack.)
#
# To move up to the full stack later, replace this file with the repository's
# compose.yaml and run `docker compose --profile database up -d`.
services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: sole
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: sole
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U sole -d sole']
      interval: 5s
      timeout: 5s
      retries: 20
    volumes:
      - postgres-data:/var/lib/postgresql/data

  web:
    image: ${WEB_IMAGE:-ghcr.io/poesterlin/sole-web:latest}
    restart: unless-stopped
    env_file: .env
    environment:
      PORT: '3000'
      NODE_ENV: production
      MUSIC_LIBRARY_PATH: /music
      DATABASE_URL: postgres://sole:${POSTGRES_PASSWORD}@postgres:5432/sole
      # SvelteKit rejects a login whose Origin does not match the app's own
      # host. Set ORIGIN in .env when serving through a domain or proxy.
      ORIGIN: ${ORIGIN:-http://127.0.0.1:${WEB_PORT:-4932}}
    ports:
      - '${WEB_PORT:-4932}:3000'
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      # Read-only: the app slices the snippets a worker downloads. No worker
      # ever reads these files.
      - music:/music:ro
    healthcheck:
      test:
        [
          'CMD',
          'bun',
          '-e',
          "const r = await fetch('http://127.0.0.1:3000/api/health'); if (!r.ok) throw new Error('status ' + r.status)",
        ]
      interval: 30s
      timeout: 10s
      start_period: 60s
      retries: 3

  # The embedding worker. API mode needs no music volume and no database — it
  # downloads bounded snippets from the app and uploads vectors back.
  worker:
    image: ${EMBEDDINGS_IMAGE:-ghcr.io/poesterlin/sole-embeddings:latest}
    entrypoint: >
      sh -c "while true; do
        echo \"[worker] $$(date): embedding...\";
        python worker.py --source-mode api || echo failed;
        sleep 43200;
      done"
    restart: unless-stopped
    init: true
    depends_on:
      web:
        condition: service_healthy
    environment:
      WORKER_URL: 'http://web:3000'
      WORKER_TOKEN: '${WORKER_TOKEN:-}'

volumes:
  postgres-data:
  music:
    driver: local
    driver_opts:
      type: none
      device: ${MUSIC_LIBRARY_PATH:-/srv/music}
      o: bind
```

Two things worth noticing: the app's port is published, so anyone who can reach this machine can reach the login page. PostgreSQL publishes nothing at all in this stack. The `music` volume is a bind to `MUSIC_LIBRARY_PATH`, mounted read-only.

:::

## 2. Create `.env`

Settings live in a file called `.env`, next to `compose.yaml`. Four of them make a working install:

| Setting | What it is |
|---|---|
| `MUSIC_LIBRARY_PATH` | The folder that holds your music. It is mounted into the app read-only, which is what lets the app slice the audio a worker analyses. Nothing writes to it. |
| `POSTGRES_PASSWORD` | A password for the database this stack creates for you. Only this stack uses it, so any random string will do — the point is not to ship a guessable default. |
| `WEB_PORT` | The local port the app listens on. You will open `http://127.0.0.1:<port>` in a moment. |
| `WORKER_TOKEN` | A shared secret between the app and a worker. The app refuses analysis requests that do not carry it, so generate a long random value. Anything that talks to the worker API uses this same string — the local worker in this stack, or a remote one. The maintenance jobs are not separate processes, so they do not use it. |

Create the file in your editor — `nano .env` — and fill in those four lines, or let this do it for you with generated secrets:

```sh
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
MUSIC_LIBRARY_PATH=$HOME/Music
WEB_PORT=4932
WORKER_TOKEN=$(openssl rand -hex 24)
EOF
chmod 600 .env
```

Change `MUSIC_LIBRARY_PATH` if your collection is not in `~/Music`. The `chmod 600` keeps the generated secrets readable only by your own account.

## 3. Start the stack

```sh
docker compose up -d --wait
```

`-d` runs it in the background; `--wait` returns only once the containers are healthy. The first run also pulls the published images, which takes a minute or two.

## 4. Create the database tables and your account

The app needs its schema before it can serve anything. This runs *inside* the web image, enables the pgvector extension, and applies the migrations in `drizzle/`:

```sh
docker compose run --rm --entrypoint sh web \
  -c 'bun scripts/ensure-pgvector.ts && bunx drizzle-kit migrate'
```

Then create your login. Without `--password`, it prints a generated one once — copy it now, it will not be shown again:

```sh
docker compose run --rm --entrypoint bun web \
  web/scripts/create-user.ts --username admin
```

Open **http://127.0.0.1:4932/login** and sign in.

Self-registration is off and the account limit is one by default. To add people later, set `MAX_USERS` to the number of accounts you want in `.env` and run the account command again with a different username. For self-service sign-ups up to that limit, also set `ALLOW_REGISTRATION=true` and run `docker compose up -d` to apply the setting. The registration link disappears when the limit is reached.

## 5. Connect Music Assistant

Whatever plays your music has to be reachable from this machine. Add two settings to `.env`, then apply them with `docker compose up -d`:

| Setting | What it is |
|---|---|
| `MUSIC_HOST` | Base URL of your Music Assistant server, for example `http://192.168.1.10:8095`. |
| `MA_TOKEN` | An access token from Music Assistant's own settings. It is how the app reads your library and controls playback. |

Music Assistant supplies the catalogue and handles playback; Sole reads the same library and works out what sounds alike. Reload the app and continue with [First playable vibe](/guides/first-play).

## What runs, and what reads your files

Only the app and PostgreSQL run, and each has its own volume. The app is the only thing that reads your music folder, and only to slice the snippets a worker asks for. The worker itself never touches your files — see [Embedding workers](/guides/worker).

The app's port is published on every interface, so it is reachable from your network. If that is not what you want, bind it to this machine only by editing the one line in `compose.yaml`:

```yaml
    ports:
      - '127.0.0.1:4932:3000'
```

Opening the app from another device needs one more setting. The login form is refused unless `ORIGIN` matches the address in your browser, so set it to the one you will actually use:

```sh
# in .env, then: docker compose up -d
ORIGIN=http://192.168.1.20:4932
```

## Common changes

Edit `.env`, then run `docker compose up -d` again.

| Want to change | Setting |
|---|---|
| Music folder | `MUSIC_LIBRARY_PATH` |
| Web port | `WEB_PORT` (default `4932`) |
| Login host, behind a proxy | `ORIGIN` — must match the address you actually open, defaults to `http://127.0.0.1:4932` |

PostgreSQL is not published to your machine, so it cannot collide with a database you already run. To look inside it:

```sh
docker compose exec postgres psql -U sole
```

## Optional: the installer script

`setup.sh` performs steps 1–4, writes a fuller `.env`, and prints the login. It is short, and worth reading before you run it:

```sh
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/setup.sh -o setup.sh
less setup.sh
bash setup.sh "$HOME/Music"
```

It will not overwrite an existing `.env`. To start over, delete `.env` and run `docker compose down -v`.

## Public domain instead

The file above is the local stack. For a domain, background jobs, and clustering profiles, use the repository's `compose.yaml` — see [Public deployment](/getting-started/public-deployment).
