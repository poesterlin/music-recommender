# Embedding workers

The default public stack includes a local Python embedding loop. A local web-only install starts no worker by default; see [First playable vibe](/guides/first-play) for a one-shot run.

For a worker on another computer, sign in and open **Manage → API keys**. Create a **Worker** key. The page provides a Colab/Jupyter cell and a notebook download; the key is displayed once. A portable worker needs the app URL and that key, not database credentials or a music mount.

```sh
export WORKER_URL=https://your-recommender.example.com
export WORKER_TOKEN='your-worker-scoped-key'
python embeddings/worker.py --source-mode api --dry-run --limit 1
```

The copied notebook cell begins with a one-track dry run. Enter a URL reachable **from the notebook machine**. `127.0.0.1` on Colab means Colab itself, not your computer.

When the dry run succeeds, remove `--dry-run` and the limit to process pending tracks. Check **Worker** for coverage and the last upload. The portable worker reports progress when batches upload; the local worker has a separate job record.
