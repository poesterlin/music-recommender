# Sole

[![CI](https://github.com/poesterlin/sole/actions/workflows/ci.yml/badge.svg)](https://github.com/poesterlin/sole/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-guidance-0f7666)](https://poesterlin.github.io/sole/)
[![License](https://img.shields.io/badge/license-MIT-0f7666)](LICENSE)

Sole browses a local music collection and recommends tracks by sound.
[Music Assistant](https://www.music-assistant.io/) supplies metadata and playback.
The Python worker analyses audio with pretrained
[OpenL3](https://github.com/marl/openl3).

Each analysed track gets an embedding: 512 numbers stored in PostgreSQL.
Sole compares embeddings and groups tracks into clusters. The interface calls
these groups **vibes**.

![Vibe view showing named clusters as cover-art tiles](docs/public/images/first-play/vibes.jpg)

## Why I made it

I wanted background music that fits the time of day.
I wanted a way to curate my song library.
I also wanted Spotify-like song recommendations from a self-hosted app using
my own music.
Sole needs no listening history or model training on your collection.
It uses Music Assistant metadata to index files and request playback.

Recommendations combine audio similarity, likes, artist limits, and a penalty
for similar picks ([recommendation code](web/src/lib/server/recomendation-engine.ts)).
Cluster names use the three most frequent artists
([naming code](web/src/lib/server/cluster-naming.ts)).

## Requirements and limits

- Install Docker Compose v2, `curl`, and `openssl` for the quick start.
- Set up Music Assistant with your local audio collection first.
  Missing connection settings prevent indexing.
- Mount the matching audio files into Sole.
  Missing files cause worker audio `404` responses.
- PostgreSQL needs the `vector` extension. The starter stack includes it.
- Sole does not analyse streaming-service catalogues. Accounts have no roles.
- `MAX_USERS=1` is the default. Raise it before creating another account.
  See [Authentication](docs/reference/application.md#authentication).
- Cluster benchmarks, targeted splits, and assignment rollback use the
  [Rust CLI](clustering-rs/README.md).
- I have mainly tested a library of about **31,500 tracks**.
  For provider issues, report the provider, error, and whether Music Assistant
  can play the affected track.

**CPU benchmark, 2026-09-30:** **5.9 seconds median** per 90-second excerpt on an
**AMD Ryzen 7 255**. Estimated **99 minutes per 1,000 tracks** for audio analysis.
[Benchmark details](embeddings/benchmark-cpu-2026-09-30.json).

## Quick start

The starter stack uses matching v0.1.1 images for web and the opt-in API worker.

```sh
mkdir sole && cd sole
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/v0.1.1/stack.yaml -o compose.yaml
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
WORKER_TOKEN=$(openssl rand -hex 24)
MUSIC_LIBRARY_PATH=$HOME/Music
MUSIC_HOST=CHANGE_ME
MA_TOKEN=CHANGE_ME
EOF
chmod 600 .env
${EDITOR:-vi} .env
```

Set `MUSIC_HOST` to your Music Assistant URL and `MA_TOKEN` to its access token.
Set `MUSIC_LIBRARY_PATH` to your existing music folder.
For another device, add `WEB_BIND_ADDRESS=0.0.0.0` and
`ORIGIN=http://your-server:3000` using your browser's address.

```sh
grep -q CHANGE_ME .env && { echo 'Replace CHANGE_ME values in .env first'; exit 1; }
docker compose up -d --wait postgres
docker compose run --rm --entrypoint sh web \
  -c 'bun scripts/ensure-pgvector.ts && bunx drizzle-kit migrate'
docker compose run --rm --entrypoint bun web \
  web/scripts/create-user.ts --username admin
docker compose up -d --wait web
```

Open `http://127.0.0.1:3000/login` with the printed password.
Open **Setup** to index tracks, create vibes, and fill missing names.
Follow [Your first playable vibe](docs/guides/first-play.md) for those steps.
After indexing, enable automatic embedding with
`docker compose --profile embedding up -d worker`. Choose the recipe on Manage
before embedding. See [Local install](docs/getting-started/local.md) for an
empty-library trial, changing ports, and replacing the music mount.

### Other ways

- [Installer script](docs/getting-started/local.md#other-ways): generates
  credentials and runs the main install path.
- [Public deployment](docs/getting-started/public-deployment.md): uses a source
  checkout and Traefik.

## Reference

- [Authentication and configuration](docs/reference/application.md)
- [Troubleshooting by symptom](docs/reference/troubleshooting.md)
- [Embedding workers](docs/guides/worker.md)
- [Python worker reference](embeddings/README.md)
- [Rust clustering CLI](clustering-rs/README.md)
- [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and
  [Code of conduct](CODE_OF_CONDUCT.md)

## AI use

I used AI heavily to develop Sole and write its documentation.
