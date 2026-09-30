# Sole docs

Published at <https://poesterlin.github.io/sole/>, built and deployed by
`.github/workflows/docs.yml` on any push that touches `docs/`.

The VitePress site has its own package and lockfile.
Its committed images allow a documentation build without an app build.

```sh
cd docs
bun install --frozen-lockfile
bun run dev
```

Build with `bun run build`; output goes to `.vitepress/dist`.
To serve it with Nginx:

```sh
docker build -t sole-docs .
docker run --rm -p 127.0.0.1:8080:80 sole-docs
```

The local-install examples run in the folder containing the downloaded stack.
Source-checkout examples run from the repository root unless a step says otherwise.
Use the [writing guide](writing-guide.md) when editing prose.
