# Local install

One command, no clone, no editing files. You need Docker; that is the only requirement.

```sh
mkdir sole && cd sole
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/setup.ts | bun run -
```

If Bun is not installed:

```sh
curl -fsSL https://bun.sh/install | bash
```

Press Enter at the single prompt (where your music lives) and wait. The script writes two files, generates secrets, pulls the published images, creates an account, and prints the login.

```
Sole setup. Press Enter to accept each default.
Folder that contains your music (read-only) [/home/you/Music]:

Ready.

  Open      http://127.0.0.1:4932/login
  Username  admin
  Password  45q8-v8EzQOjWXf4
```

Log in and follow the **Setup** page from there.

## What it creates

Both files sit in the folder you made and can be edited afterwards.

| File | Purpose |
|---|---|
| `compose.yaml` | The stack. Downloaded, so no clone is needed. |
| `.env` | Your settings and generated secrets. Never commit it. |

Only the web app and PostgreSQL run, and both bind to `127.0.0.1`.

Your music folder is mounted into the app read-only, because the app slices the snippets the worker analyses. Nothing else reads your files: the worker only ever talks to the app's API.

## Connect Music Assistant

Add these to `.env`, then run `docker compose up -d`:

| Setting | What it is |
|---|---|
| `MUSIC_HOST` | Base URL of your Music Assistant server |
| `MA_TOKEN` | Music Assistant access token |

Music Assistant supplies the catalogue and playback. Reload **Setup** to confirm it connects, then continue with [First playable vibe](/guides/first-play).

## Common changes

Edit `.env`, then run `docker compose up -d` again.

| Want to change | Setting |
|---|---|
| Music folder | `MUSIC_LIBRARY_PATH` |
| Web port | `WEB_PORT` (default `4932`) |
| PostgreSQL port | `POSTGRES_PORT` (default `5432`) |
| Login host, behind a proxy | `ORIGIN` (defaults to `http://127.0.0.1:4932`) |

## Going further

The published `compose.yaml` is the full stack: it adds the timed jobs, the embedding worker, clustering profiles, and the Traefik labels for a public domain. The setup script writes the same file, so there is no switch to flip later.

To build from source instead of pulling images:

```sh
git clone https://github.com/poesterlin/sole.git
cd sole
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

## If something goes wrong

The setup script will not overwrite an existing `.env`. To start over, delete `.env` and the Docker volumes for this folder, then run it again.

Set `ORIGIN` if a reverse proxy serves the app on a different hostname, otherwise login is refused for safety.
