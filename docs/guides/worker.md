# Embedding workers

The API worker downloads audio snippets, computes embeddings, and uploads them.
It needs no database connection or music mount.
See the [Python reference](https://github.com/poesterlin/sole/blob/main/embeddings/README.md)
for local-file mode, dependencies, and command options.

## Default Compose worker

[Local install](/getting-started/local) starts the worker with `WORKER_TOKEN`.
The loop waits twelve hours after draining the backlog.
It waits five minutes if tracks remain, or fifteen minutes after an error.
See the [starter loop](https://github.com/poesterlin/sole/blob/main/stack.yaml).

`docker compose up -d worker` starts a stopped service.
It does not wake a worker already sleeping. Run a separate bounded check:

```sh
docker compose run --rm --entrypoint python worker \
  worker.py --source-mode api --dry-run --limit 10
```

Remove `--dry-run` to upload results. Remove `--limit 10` to process the backlog.

## Remote machine or Colab

Create a **Worker** key under **API keys**.
You can revoke this key without changing the default Compose worker's token.
The page provides a Colab/Jupyter cell and notebook download.

For a source checkout with Python dependencies installed, run:

```sh
export WORKER_URL=https://sole.example.com
export WORKER_TOKEN='your-worker-scoped-key'
python embeddings/worker.py --source-mode api --dry-run --limit 1
```

Use a URL reachable from the worker machine.
`127.0.0.1` in Colab points to Colab, not your server.
After the dry run succeeds, remove `--dry-run` and `--limit 1` to upload embeddings.
Open **Worker** to check the last upload. Counts change after a batch uploads.

Set `EMBEDDING_STATE_FILE` on persistent storage to retain the worker cursor.
The worker saves it after successful pages
([API worker code](https://github.com/poesterlin/sole/blob/main/embeddings/worker_api.py)).
