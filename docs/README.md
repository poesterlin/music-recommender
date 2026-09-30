# Sole docs

Published at <https://poesterlin.github.io/sole/>, built and deployed by
`.github/workflows/docs.yml` on any push that touches `docs/`.

This VitePress site has its own package and lockfile. No app build or shared asset is needed.

```sh
cd docs
bun install --frozen-lockfile
bun run dev
```

Use `bun run build` to generate `.vitepress/dist` and `bun run preview` to view that build. To serve it with Nginx:

```sh
docker build -t sole-docs .
docker run --rm -p 127.0.0.1:8080:80 sole-docs
```

The Markdown examples describe commands run from the **Sole repository root**. Keep them aligned with the app's `README.md` and Compose configuration when those change.
