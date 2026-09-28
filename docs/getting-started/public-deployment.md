# Public deployment

This path uses the repository's Compose stack and an existing Traefik network. Run commands from the repository root. The published images are used as-is.

1. Copy `.env.example` to `.env` and set `DOMAIN`, `MUSIC_LIBRARY_PATH`, `MUSIC_HOST`, `MA_TOKEN`, and `WORKER_TOKEN`. The worker token authenticates the default timed jobs; scoped keys for external workers can be created in the UI instead.
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

4. Open your domain, register, and follow **Setup**. The stack includes the analyzer and a local embedding loop, so a new library fills in on its own. [First playable vibe](/guides/first-play) explains the centering and clustering steps that follow.

Keep `.env` out of source control. PostgreSQL should remain private; the optional Compose database binds its host port to localhost.
