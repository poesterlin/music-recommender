# Getting started

Sole groups local tracks by sound and recommends tracks from a song you choose.
Music Assistant supplies track metadata and playback.

The Python worker uses OpenL3 to create an embedding: 512 numbers describing
each track's audio. PostgreSQL stores these embeddings with the `vector`
extension. Sole groups them into clusters. The interface calls clusters
**vibes**.

## Requirements and limits

- Install Docker Compose v2, `curl`, and `openssl`.
- Set up Music Assistant with your local audio library first.
- Mount those audio files into Sole. Missing files cause worker audio `404`
  responses. See [audio troubleshooting](/reference/troubleshooting).
- Sole does not analyse streaming-service catalogues.
- Sole does not train a model on your collection.

## Install

Follow [Local install](/getting-started/local), then
[Your first playable vibe](/guides/first-play).

## Other ways

For a source checkout behind Traefik, follow
[Public deployment](/getting-started/public-deployment).
