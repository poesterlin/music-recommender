# Embedding workers

A worker turns each track into a vector. It talks to the app's API only: it downloads snippets, computes, and uploads the results. It needs no database, no music folder, and no access to your files.

## On this machine

A local install ships the worker behind a profile. Start it when you want to analyse the library:

```sh
docker compose --profile worker up -d
```

The public Compose stack runs an equivalent loop by default.

## On another machine or in Colab

Sign in and open **Manage → API keys**, then create a **Worker** key. The page provides a ready-made Colab/Jupyter cell and a notebook download; the key is shown once.

```sh
export WORKER_URL=https://your-sole.example.com
export WORKER_TOKEN='your-worker-scoped-key'
python embeddings/worker.py --source-mode api --dry-run --limit 1
```

Enter a URL reachable **from the worker machine**. `127.0.0.1` in Colab means Colab itself, not your computer, so a remote worker needs the public address or a tunnel.

The copied cell starts with a one-track dry run. When that succeeds, remove `--dry-run` and the limit. Check **Worker** for coverage and the last upload; progress appears once the first batch uploads.
