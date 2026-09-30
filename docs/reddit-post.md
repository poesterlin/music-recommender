# Reddit post draft

Suggested community: r/selfhosted. Review the community's current posting rules
and flair before publishing.

## Title

I built Sole: a self-hosted way to rediscover your music library by sound

## Body

I've been building **Sole**, an open-source app that groups a local music library
by how the tracks sound, and recommends tracks from a song you choose.

I wanted another way to explore my own collection beyond artist names, genres,
and playlists. Sole uses a pretrained OpenL3 audio model to produce embeddings,
stores them in PostgreSQL with pgvector, and groups the tracks into “vibes.”
It doesn't need listening history or a model trained on your collection.

What it does:

- Browse sound-based clusters as cover-art tiles.
- Automatically name clusters after their dominant artists; edit the names yourself.
- Pick a seed track and get a playlist of similar tracks with artist diversity.
- Schedule a vibe to play at a particular time.
- Explore a 2D map of the clusters and inspect/play individual tracks.
- Run the embedding worker on the same host or a separate machine.

**It requires Music Assistant**, which supplies the library metadata and handles
playback. You also need your own audio files, Docker Compose, and PostgreSQL with
pgvector (included in the starter stack). This is for people who already have,
or want to run, that setup. Sole does not analyse streaming-service catalogues.

I'm running it against roughly **31,500 tracks**.
On 2026-09-30, one 90-second excerpt took **5.9 seconds median** across three CPU passes.
The CPU was an **AMD Ryzen 7 255**, with a reused model and inference batch `64`.
That excludes startup, downloads, snippet generation, and uploads.
The [benchmark record](https://github.com/poesterlin/sole/blob/main/embeddings/benchmark-cpu-2026-09-30.json)
contains the timings and sampling settings.

The clusters are sound groupings, not reliable genre labels.
I'd appreciate reports from other collections or Music Assistant providers.

**Source:** https://github.com/poesterlin/sole

**Install/docs:** https://poesterlin.github.io/sole/

## Before publishing

- Publish container images containing the current changes, and verify a fresh
  installation using those published images. Local deployment builds do not
  publish to GHCR.
- Replace the older Setup screenshot when presenting the current interface.
