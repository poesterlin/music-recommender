# Troubleshooting

| What you see | What to check |
|---|---|
| Setup says an integration is not configured | Add its fields to the active env file and recreate the web container. Use **Test connections** again. |
| Music Assistant cannot connect | Check `MUSIC_HOST` and `MA_TOKEN` from the web container's network. |
| Import is disabled | Home Assistant needs `HA_HOST`, `TOKEN`, and `CONFIG_ID`. |
| Tracks appear, but no vibe plays | Check **Worker** for embeddings, centered vectors, and centroids. These are separate steps. |
| Worker audio is missing | The host library mount and the track's local file must agree. |
| A Colab worker cannot reach localhost | Enter a URL reachable from Colab on **Manage → API keys**. |
| PostgreSQL reports a vector error | Run `bun run db:migrate` against the intended database with permission to enable pgvector. |

For details on jobs and optional profiles, see the repository `README.md`. Never put API keys or database passwords into a screenshot or a support report.
