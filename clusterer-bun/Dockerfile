FROM rust:1.78-bookworm AS wasm-builder
RUN rustup target add wasm32-unknown-unknown
WORKDIR /src
COPY clustering-wasm/Cargo.toml clustering-wasm/Cargo.lock ./clustering-wasm/
COPY clustering-wasm/src ./clustering-wasm/src
COPY clustering-rs ./clustering-rs
WORKDIR /src/clustering-wasm
RUN cargo build --release --locked --target wasm32-unknown-unknown

FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY scripts/clusterer.ts ./scripts/clusterer.ts
COPY --from=wasm-builder /src/clustering-wasm/target/wasm32-unknown-unknown/release/clustering_wasm.wasm /app/clustering_wasm.wasm
RUN mkdir -p /artifacts && chown 65532:65532 /artifacts
USER 65532:65532
ENV CLUSTER_WASM=/app/clustering_wasm.wasm
ENTRYPOINT ["bun", "/app/scripts/clusterer.ts"]
