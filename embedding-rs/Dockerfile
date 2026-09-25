FROM rust:1.78-bookworm AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile-dev libsoxr-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY embedding-rs/Cargo.toml embedding-rs/Cargo.lock ./
RUN mkdir -p src \
    && printf 'fn main() {}\n' > src/main.rs \
    && : > src/lib.rs \
    && cargo build --release --locked --bin embedding-worker --features production

COPY embedding-rs/src ./src
RUN touch src/main.rs src/lib.rs \
    && cargo build --release --locked --bin embedding-worker --features production

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libgcc-s1 libsndfile1 libsoxr0 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /src/target/release/embedding-worker /usr/local/bin/embedding-worker
COPY embedding-rs/model-lock.json /app/model-lock.json
RUN mkdir -p /artifacts && chown 65532:65532 /artifacts
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/embedding-worker"]
