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
or want to run, that kind of setup—not a streaming-service replacement.

I'm running it against roughly **31,500 tracks**. A recent benchmark of the
recommendation engine returned 30 tracks in about **93 ms median** across ten
warm runs. That's for one seed on my hardware and excludes HTTP overhead and
Music Assistant validation; the initial audio analysis is much slower and can
take hours or days for a large collection.

It's an early-stage, single-contributor project. The vibes are automatic sound
groupings rather than reliable genre labels, and the app is primarily designed
for a personal library. I'd particularly appreciate feedback from people with
different collections or Music Assistant providers.

**Source:** https://github.com/poesterlin/sole

**Install/docs:** https://poesterlin.github.io/sole/

## Suggested images

1. Lead with the Vibe cover-art browser.
2. Show the 2D atlas with a selected track.
3. Show Worker progress if including a third image.

Capture the current interface. The committed Setup screenshot predates the live
checklist, so it should not be used as a screenshot of the current release.

## Before publishing

- Publish container images containing the current changes, and verify a fresh
  installation using those published images. Local deployment builds do not
  publish to GHCR.
- Make sure the public documentation site includes the latest setup instructions.
- Replace the older Setup screenshot when presenting the current interface.
