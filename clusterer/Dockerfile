FROM rust:1.78-bookworm AS builder
WORKDIR /src

COPY clustering-rs/Cargo.toml clustering-rs/Cargo.lock ./
RUN mkdir -p src \
    && printf 'fn main() {}\n' > src/main.rs \
    && : > src/lib.rs \
    && cargo build --release --locked

COPY clustering-rs/src ./src
RUN touch src/main.rs src/lib.rs \
    && cargo build --release --locked

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /src/target/release/cluster-bench /usr/local/bin/cluster-bench
RUN mkdir -p /artifacts && chown 65532:65532 /artifacts

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/cluster-bench"]
