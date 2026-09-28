# Public deployment

This path uses the repository's Compose stack and an existing Traefik network. Run commands from the repository root.

1. Copy `.env.example` to `.env` and set `DOMAIN`, `MUSIC_LIBRARY_PATH`, `MUSIC_HOST`, `MA_TOKEN`, and `WORKER_TOKEN`. The last token authenticates the default timed jobs. `PLAYBACK_API_KEY` is needed only if an external system will call playback with that bootstrap key; a scoped key can also be created in the UI.
2. Point `DATABASE_URL` at PostgreSQL with pgvector. If using the optional Compose database, start it first:

   ```sh
   docker network create "${TRAEFIK_NETWORK:-traefik_web}" 2>/dev/null || true
   docker compose --profile database up -d postgres
   ```

   Host commands use `DATABASE_URL`; containers use `DATABASE_INTERNAL_URL` when set.

3. Install the schema, run the preflight, and start the stack:

   ```sh
   bun install --frozen-lockfile
   bun run db:migrate
   bun run doctor -- --strict
   docker compose up -d
   ```

4. Open your domain, register, and follow **Setup**. The default stack includes Music Assistant sync, analyzer, and a local embedding loop. [First playable vibe](/guides/first-play) explains the separate centering and clustering steps.

Keep `.env` out of source control. PostgreSQL should remain private; the optional Compose database binds its host port to localhost.
