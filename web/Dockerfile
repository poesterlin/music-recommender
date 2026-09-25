FROM oven/bun:1 AS base
WORKDIR /app

# The portable worker API serves bounded audio snippets to remote workers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

EXPOSE 3000
ENV PORT=3000
CMD ["bun", "build/index.js"]
