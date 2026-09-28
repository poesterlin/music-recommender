# Troubleshooting

| What you see | What to check |
|---|---|
| Music Assistant cannot connect | Check `MUSIC_HOST` and `MA_TOKEN` from the web container's network. |
| Tracks appear, but no vibe plays | Check **Worker** for embeddings, centered vectors, and centroids. These are separate steps. |
| Nothing is analysed | A local install starts no worker. Run `docker compose --profile worker up -d`. |
| The worker reports 401 | Its token does not match the app's. The local worker uses `WORKER_TOKEN` from `.env`; a remote one uses a Worker-scoped key from **Manage → API keys**. Both must be non-empty. |
| Worker audio is missing | The app host's library mount and the track's local file must agree. A remote worker needs no files, only a reachable URL. |
| A Colab worker cannot reach localhost | Enter a URL reachable from Colab on **Manage → API keys**. |
| PostgreSQL reports a vector error | Run `bun run db:migrate` against the intended database with permission to enable pgvector. |
| Login is refused | Set `ORIGIN` to the address you actually open the app on. |

For details on jobs and optional profiles, see the repository `README.md`. Never put API keys or database passwords into a screenshot or a support report.
