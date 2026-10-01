# Local install

Run the published images with the starter Compose stack.
Read [requirements and limits](/getting-started/) before starting.

## 1. Download the stack

```sh
mkdir sole && cd sole
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/v0.1.2/stack.yaml -o compose.yaml
```

The [starter stack](https://github.com/poesterlin/sole/blob/main/stack.yaml)
uses the matching v0.1.2 web and worker images. PostgreSQL and web start by
default; the API worker is enabled explicitly after setup.
Only the web app mounts your music folder. The mount is read-only.

## 2. Set credentials and paths

Create `.env` next to `compose.yaml`:

```sh
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
WORKER_TOKEN=$(openssl rand -hex 24)
MUSIC_LIBRARY_PATH=$HOME/Music
MUSIC_HOST=CHANGE_ME
MA_TOKEN=CHANGE_ME
EOF
chmod 600 .env
${EDITOR:-vi} .env
```

Replace `CHANGE_ME` before starting containers:

- Set `MUSIC_HOST` to your Music Assistant URL, such as
  `http://192.168.1.10:8095`.
- Set `MA_TOKEN` to an access token from Music Assistant's settings.
- Set `MUSIC_LIBRARY_PATH` to the existing folder containing your audio files.

For another device, add `ORIGIN=http://your-server:3000`.
Use the exact address you will open in the browser. A mismatch causes login
form requests to return `403`.

The default port is 3000, bound to loopback. If it is occupied, add
`WEB_PORT=3010` and open `http://127.0.0.1:3010/login`. Set `ORIGIN` to that URL
if you have explicitly configured it. For access from another device, also set
`WEB_BIND_ADDRESS=0.0.0.0` and use that device's reachable hostname in `ORIGIN`.

To try the account and UI without a library connection, leave `MUSIC_HOST` and
`MA_TOKEN` empty and point `MUSIC_LIBRARY_PATH` at an existing empty directory.
Scheduled maintenance stays disabled until both Music Assistant values are set.

## 3. Start containers and create tables

```sh
grep -q CHANGE_ME .env && { echo 'Replace CHANGE_ME values in .env first'; exit 1; }
docker compose up -d --wait postgres
docker compose run --rm --entrypoint sh web \
  -c 'bun scripts/ensure-pgvector.ts && bunx drizzle-kit migrate'
docker compose up -d --wait web
```

Container health checks do not verify the schema or Music Assistant connection.

## 4. Create an account

```sh
docker compose run --rm --entrypoint bun web \
  web/scripts/create-user.ts --username admin
```

Open `http://127.0.0.1:3000/login` with the printed password.
Continue with [Your first playable vibe](/guides/first-play).

After configuring Music Assistant and indexing your library, enable automatic
embedding with:

```sh
docker compose --profile embedding up -d worker
```

This starts a continuous worker that writes embeddings. Choose the global recipe
on Manage before embedding; populated libraries keep their existing recipe.

## Reference

After editing `.env`, run `docker compose up -d` to recreate affected services.
Changing `MUSIC_LIBRARY_PATH` also requires recreating the named music bind
volume. With the default Compose project name, run:

```sh
docker compose down
docker volume rm "$(basename "$PWD")_music"
docker compose up -d --wait
```

If you set a project name with `-p` or `COMPOSE_PROJECT_NAME`, use that prefix
instead. Remove only the `music` volume; keep `postgres-data`. Restart the worker
with the profile command above if it was enabled.
See [Authentication and configuration](/reference/application) for account
limits, worker settings, and database commands.

## Other ways

### Upgrade an existing starter installation

Keep `.env` and the database volume. Set both image versions in `.env`:

```dotenv
WEB_IMAGE=ghcr.io/poesterlin/sole-web:v0.1.2
EMBEDDINGS_IMAGE=ghcr.io/poesterlin/sole-embeddings:v0.1.2
```

Then stop application services, migrate using the new web image, and restart:

```sh
docker compose stop web worker
docker compose --profile embedding pull web worker
docker compose up -d --wait postgres
docker compose run --rm --no-deps --entrypoint sh web \
  -c 'bun scripts/ensure-pgvector.ts && bunx drizzle-kit migrate'
docker compose up -d --wait web
```

Restart the worker explicitly if you use it. Existing embedded libraries inherit
their recorded recipe; fresh libraries default to medium mode and 90-second
samples. Upgrade web and worker together: current workers require the server to
provide a recipe. Do not recreate your admin account unless you intend to reset
its password.

### Installer

The [installer script](https://github.com/poesterlin/sole/blob/main/setup.sh)
automates the main install path:

```sh
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/v0.1.2/setup.sh -o setup.sh
bash setup.sh "$HOME/Music"
```

The script uses `stack.yaml`. Add `-f stack.yaml` to later Compose commands.
For Traefik and a source checkout, see
[Public deployment](/getting-started/public-deployment).
