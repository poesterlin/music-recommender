# Local install

Run these commands from the Music Recommender repository root.

```sh
bun --no-env-file scripts/setup-local.ts /absolute/path/to/music
```

The command creates `.env.local`, starts a private pgvector database, applies migrations, and starts the web app. It does **not** read or change `.env`. It refuses to overwrite an existing `.env.local`.

Open **http://127.0.0.1:4933/register**, create an account, then open **Setup**. Playback stays unavailable until the library and vibes are ready.

## Connect your services

In `.env.local`, fill in `MUSIC_HOST` and `MA_TOKEN` for Music Assistant, and `HA_HOST`, `TOKEN`, and `CONFIG_ID` for Home Assistant. Restart the web container so it reads the new values:

```sh
docker compose --project-name music-recommender-local --env-file .env.local up -d --force-recreate web
```

Use **Setup → Test connections** to check them. Then [import music and build your first vibe](/guides/first-play).

::: info Local ports
The app uses `127.0.0.1:4933`; PostgreSQL uses `127.0.0.1:55433`. Both are bound to this computer. The local command starts only web and database; workers and timed jobs are separate.
:::

If the first command stops partway through, use the resume commands in the repository `README.md` under **Local first run**. Do not run a database command against another `.env` by accident.
