FROM oven/bun:1 AS base
WORKDIR /app

# The portable worker API serves bounded audio snippets to remote workers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The build context is the repository root (see compose.yaml and release.yml)
# so this image can also carry the schema and helper scripts it needs at
# runtime. Dependency installation still uses the web workspace's own manifest.
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile

COPY web/ .
RUN bun run build

# Migrations and account seeding run inside this image on first start.
COPY drizzle ./drizzle
COPY drizzle.config.ts ./drizzle.config.ts
COPY scripts ./scripts
COPY web/scripts ./web/scripts

EXPOSE 3000
ENV PORT=3000
CMD ["bun", "build/index.js"]
