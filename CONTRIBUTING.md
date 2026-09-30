# Contributing

## Before you open a pull request

The [CI workflow](.github/workflows/ci.yml) defines the automated checks.

```sh
# web
cd web && bun install --frozen-lockfile && bun run check && bun test && cd ..

# Python: use the image to provide the worker dependencies.
docker build -t sole-embeddings:ci embeddings
docker run --rm \
  --volume "$PWD/embeddings:/workspace-tests:ro" \
  --entrypoint python \
  sole-embeddings:ci \
  -m unittest discover -s /workspace-tests/tests

# rust
cargo test --manifest-path clustering-rs/Cargo.toml --locked

# generated assets must still match their source
cd assets && bun run check
```

Mount the whole `embeddings` directory, not just `embeddings/tests` — the test
modules import from their parent and fail to load otherwise, which looks like
"2 tests, 2 errors" rather than a mounting mistake.

`bun run check` must report **0 errors and 0 warnings**.
I have shipped stale prop values and non-reactive `Set` mutations despite working builds.
Fix warnings before opening a pull request.

## History: the missing worker path

The Python worker's API mode lost its primary code path in a refactor. The
worker still started, still logged sensibly, and still exited zero. `svelte-check`
passed, 61 web tests passed, 29 Python tests passed, the production build
succeeded, and `doctor --strict` reported a healthy host. Every automated check in
this repository agreed the code was fine, because every one of them tested the
code that was left rather than the code that was supposed to run.

It was caught by running the actual worker against the actual library and
watching zero embeddings appear.

Runtime checks take longer than unit tests, but they exercise the actual entry point.
Run the worker if you change it.
Run schema changes against disposable PostgreSQL with pgvector.
If you cannot run a check, state that in the pull request and list what you did check.

When you add a test for a bug, confirm it actually fails without the fix:

```sh
# Keep the regression test in place and temporarily revert only the fix.
bun test             # the regression test must fail
# Restore the fix.
bun test             # the regression test must pass
```

A regression test that passes without the fix does not demonstrate that bug.

## Changing the database

Migrations live in `drizzle/` as plain SQL and are applied in order.

- Never edit a migration that has shipped in a release. Add a new one.
- `scripts/ensure-centered-space.ts` runs before migrations.
  It skips schema changes when the schema is current.
  Its `10s` lock timeout limits waiting for a conflicting lock.
- A writer must declare its embedding space as a `recipe` (`model`, `hopSeconds`,
  `maxSampleSeconds`, `frontend`). The server resolves it by **exact match with no
  fallback** and returns 409 on a miss, then stamps `embedding_space_version`.
  Embeddings from two different spaces are not comparable, so a silent fallback
  would quietly corrupt similarity search rather than fail.
- Verify against a disposable database, not the live one:

  ```sh
  bun run db:migrate && FRESH_DATABASE=1 bun run test:fresh-db
  ```

## Reporting something you found

If it might be a security issue, do not open a public issue. See
[SECURITY.md](SECURITY.md).
