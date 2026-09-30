# Local install

Run the published images with the starter Compose stack.
Read [requirements and limits](/getting-started/) before starting.

## 1. Download the stack

```sh
mkdir sole && cd sole
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/stack.yaml -o compose.yaml
```

The [starter stack](https://github.com/poesterlin/sole/blob/main/stack.yaml)
starts PostgreSQL, the web app, and the API worker.
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

## 3. Start containers and create tables

```sh
grep -q CHANGE_ME .env && { echo 'Replace CHANGE_ME values in .env first'; exit 1; }
docker compose up -d --wait
docker compose run --rm --entrypoint sh web \
  -c 'bun scripts/ensure-pgvector.ts && bunx drizzle-kit migrate'
```

Container health checks do not verify the schema or Music Assistant connection.

## 4. Create an account

```sh
docker compose run --rm --entrypoint bun web \
  web/scripts/create-user.ts --username admin
```

Open `http://127.0.0.1:3000/login` with the printed password.
Continue with [Your first playable vibe](/guides/first-play).

## Reference

The starter stack publishes port `3000` on every network interface.
To restrict access to this machine, change its `ports` entry:

```yaml
ports:
  - '127.0.0.1:3000:3000'
```

PostgreSQL has no published port in this stack.

After editing `.env`, run `docker compose up -d` to recreate affected services.
See [Authentication and configuration](/reference/application) for account
limits, worker settings, and database commands.

## Other ways

The [installer script](https://github.com/poesterlin/sole/blob/main/setup.sh)
automates the main install path:

```sh
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/setup.sh -o setup.sh
bash setup.sh "$HOME/Music"
```

The script uses `stack.yaml`. Add `-f stack.yaml` to later Compose commands.
For Traefik and a source checkout, see
[Public deployment](/getting-started/public-deployment).
