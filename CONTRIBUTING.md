# Contributing

This is a one-person project built at weekends. That shapes what is realistic to
review: small, focused pull requests with a clear description of *why* are much
more likely to land than a sweeping refactor. Issues and questions are welcome
and there is no contributor gate — open one and it will be read.

## Before you open a pull request

Everything below runs in CI. Running it locally first is faster than waiting for
CI to tell you the same thing.

```sh
# web -- 61 tests
cd web && bun install --frozen-lockfile && bun run check && bun test && cd ..

# python -- 34 tests. These MUST run in the image; the host interpreter is
# missing numpy and onnxruntime, so running them directly fails on ImportError
# long before it reaches an assertion.
docker build -t sole-embeddings:ci embeddings
docker run --rm \
  --volume "$PWD/embeddings:/workspace-tests:ro" \
  --entrypoint python \
  sole-embeddings:ci \
  -m unittest discover -s /workspace-tests/tests

# rust
cargo test --manifest-path clustering-rs/Cargo.toml --locked
cargo test --manifest-path clustering-wasm/Cargo.toml --locked
cargo test --manifest-path embedding-rs/Cargo.toml --locked \
  --no-default-features --features 'cli onnxruntime'

# generated assets must still match their source
cd assets && bun run check
```

Mount the whole `embeddings` directory, not just `embeddings/tests` — the test
modules import from their parent and fail to load otherwise, which looks like
"2 tests, 2 errors" rather than a mounting mistake.

`bun run check` must report **0 errors and 0 warnings**. Warnings are treated as
failures on purpose: this project has repeatedly shipped behaviour that was
technically correct and still wrong — a variable captured from a prop that should
have tracked it, a `Set` mutated without being reactive. The compiler already
knows about those patterns, so a warning is a free bug report and is not ignored.

## The bug that shaped this project

Worth stating plainly, because it is the reason for the rule above.

The Python worker's API mode lost its primary code path in a refactor. The
worker still started, still logged sensibly, and still exited zero. `svelte-check`
passed, 61 web tests passed, 29 Python tests passed, the production build
succeeded, and `doctor --strict` reported a healthy host. Every automated check in
this repository agreed the code was fine, because every one of them tested the
code that was left rather than the code that was supposed to run.

It was caught by running the actual worker against the actual library and
watching zero embeddings appear.

So: **a green check is evidence, not proof.** If your change affects runtime
behaviour, run the thing. If it affects the worker, run the worker. If it affects
the schema, run it against a real PostgreSQL with pgvector. If you cannot, say
so in the pull request and say what you did check.

When you add a test for a bug, confirm it actually fails without the fix:

```sh
git stash            # or revert just the fix
bun test             # the new test must fail
git stash pop
bun test             # and now pass
```

A test that passes both before and after the fix is testing nothing.

## Changing the database

Migrations live in `drizzle/` as plain SQL and are applied in order.

- Never edit a migration that has shipped in a release. Add a new one.
- `scripts/ensure-centered-space.ts` runs before migrations and skips its DDL when
  the schema is already current. It takes a `10s` lock timeout so it cannot
  collide with a live deployment.
- A writer must declare its embedding space as a `recipe` (`model`, `hopSeconds`,
  `maxSampleSeconds`, `frontend`). The server resolves it by **exact match with no
  fallback** and returns 409 on a miss, then stamps `embedding_space_version`.
  Embeddings from two different spaces are not comparable, so a silent fallback
  would quietly corrupt similarity search rather than fail.
- Verify against a disposable database, not the live one:

  ```sh
  bun run db:migrate && FRESH_DATABASE=1 bun run test:fresh-db
  ```

## Style

Match the surrounding code. Tabs in Svelte files, single quotes, no semicolon
chasing, no new dependencies without discussing them in an issue first. Comments
should explain *why* something is done — the code already says what. Several
comments in this repository exist to stop a future reader from "fixing" a
deliberate decision back into a bug; leave those in place and keep them accurate.

## Reporting something you found

If it might be a security issue, do not open a public issue. See
[SECURITY.md](SECURITY.md).
