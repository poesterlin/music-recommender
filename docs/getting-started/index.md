# Getting started

Music Assistant organises your library: it knows every track's name, artist, album, and where the file lives, and it plays them. What it cannot tell you is what those tracks *sound* like, so it has nothing to build a recommendation from beyond tags and your listening history.

Sole adds that missing layer. A worker listens to your songs and turns each one into a vector: a set of numbers that captures the actual sound, so tracks with a similar feel end up near each other. From those vectors the app groups your library into clusters — "vibes" — that you can name, browse, and play.

So the split is:

- **Music Assistant** — the catalog and playback. Your music stays where it is.
- **Sole** — the listening and the grouping. It reads the same library and shows you what belongs together.

It stores those vectors in PostgreSQL with pgvector.

## Choose a path

- [Local install](/getting-started/local): one command on your own machine.
- [Public deployment](/getting-started/public-deployment): a domain, background jobs, and the full Compose stack.

Then follow [First playable vibe](/guides/first-play). The app's **Setup** page shows which steps are ready.

::: tip Before you start
You need Docker, a music folder, and Music Assistant. A fresh database is created for you.
:::
