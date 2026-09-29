# Embedding workers

A worker turns each track into a vector. It talks to the app's API only: it downloads snippets, computes, and uploads the results. It needs no database, no music folder, and no access to your files.

## On this machine

The worker runs alongside the app by default and authenticates with `WORKER_TOKEN` from your `.env`, which the install steps had you generate. It loops every twelve hours; to make it analyse the library now:

```sh
docker compose up -d worker
```

## On another machine or in Colab

Sign in and open **Manage → API keys**, then create a **Worker** key. This is the better choice off this machine: it is a scoped credential you can revoke on its own, rather than sharing the stack's `WORKER_TOKEN`. The page provides a ready-made Colab/Jupyter cell and a notebook download; the key is shown once.

```sh
export WORKER_URL=https://your-sole.example.com
export WORKER_TOKEN='your-worker-scoped-key'
python embeddings/worker.py --source-mode api --dry-run --limit 1
```

Enter a URL reachable **from the worker machine**. `127.0.0.1` in Colab means Colab itself, not your computer, so a remote worker needs the public address or a tunnel.

The copied cell starts with a one-track dry run. When that succeeds, remove `--dry-run` and the limit. Check **Worker** for coverage and the last upload; progress appears once the first batch uploads.
