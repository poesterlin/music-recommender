# Local install

Docker is the only requirement. Every step below is an explicit command you can read before it runs — nothing is piped from the internet into a shell.

## 1. Get the files

```sh
mkdir sole && cd sole
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/stack.yaml -o compose.yaml
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/.env.example -o .env.example
```

`compose.yaml` is the stack: PostgreSQL, the app, and an optional worker. Open it if you want to see what will run; it is about fifty lines.

## 2. Write a minimal `.env`

```sh
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
MUSIC_LIBRARY_PATH=$HOME/Music
WEB_PORT=4932
EOF
chmod 600 .env
```

Those three are all the stack needs to start. `.env.example` lists every other setting, including the Music Assistant details you add in step 5.

## 3. Start it

```sh
docker compose up -d --wait
```

## 4. Create the schema and your account

```sh
docker compose run --rm --entrypoint sh web \
  -c 'bun scripts/ensure-pgvector.ts && bunx drizzle-kit migrate'

docker compose run --rm --entrypoint bun web \
  web/scripts/create-user.ts --username admin
```

The second command prints a generated password once — copy it. Then open **http://127.0.0.1:4932/login** and sign in.

## 5. Connect Music Assistant

Add these to `.env`, then run `docker compose up -d`:

| Setting | What it is |
|---|---|
| `MUSIC_HOST` | Base URL of your Music Assistant server |
| `MA_TOKEN` | Music Assistant access token |

Reload the app and follow the **Setup** page, then continue with [First playable vibe](/guides/first-play).

## What runs, and which files are read

Only the app and PostgreSQL run, and both bind to `127.0.0.1`. Your music folder is mounted into the app read-only, because the app slices the snippets the worker analyses. Nothing else reads your files: the worker only ever talks to the app's API.

## Common changes

Edit `.env`, then run `docker compose up -d` again.

| Want to change | Setting |
|---|---|
| Music folder | `MUSIC_LIBRARY_PATH` |
| Web port | `WEB_PORT` (default `4932`) |
| Login host, behind a proxy | `ORIGIN` (defaults to `http://127.0.0.1:4932`) |

PostgreSQL is not published to the host, so it cannot collide with a database you already run. To look inside it:

```sh
docker compose exec postgres psql -U sole
```

## Optional: the installer script

The repository also carries `setup.sh`, which performs steps 1–4, writes a fuller `.env`, and prints the login. It is short and worth reading first:

```sh
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/setup.sh -o setup.sh
less setup.sh
bash setup.sh "$HOME/Music"
```

It will not overwrite an existing `.env`. To start over, delete `.env` and the Docker volumes for this folder.

## Public domain instead

The file above is the local stack. For a domain, background jobs, and clustering profiles, use the repository's `compose.yaml` — see [Public deployment](/getting-started/public-deployment).
