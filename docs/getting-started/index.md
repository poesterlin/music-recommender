# Getting started

Sole uses a web app, PostgreSQL with pgvector, and a worker that listens to short audio excerpts. Music Assistant supplies the catalog and playback; Home Assistant supplies the current library import endpoint.

## Choose a path

- [Local install](/getting-started/local): one command creates an isolated database and starts the app on your computer.
- [Public deployment](/getting-started/public-deployment): configure the domain, integrations, and default background jobs.

Then follow [First playable vibe](/guides/first-play). The app's **Setup** page shows which steps are ready and lets you test the two connections.

::: tip Before you start
You need Bun, Docker Compose v2, a music folder readable by Docker, Music Assistant, and Home Assistant. A fresh database is created automatically on the local path.
:::
