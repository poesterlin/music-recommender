# Security

## Report a vulnerability

Use [GitHub's private vulnerability report](https://github.com/poesterlin/sole/security/advisories/new).
Include reproduction steps and the expected impact.
I offer no bug bounty or response-time guarantee.

## Audio access

The web app reads audio mounted at `/music`.
Authenticated workers download bounded snippets through
[`/api/worker/audio`](web/src/routes/api/worker/audio/+server.ts).
A remote worker receives those snippets on its machine.

## Credentials and exposure

See [Authentication](docs/reference/application.md#authentication) and
[API key scopes](docs/reference/application.md#api-keys).
`WORKER_TOKEN` also authorises two maintenance POST routes; it is broader than
a UI-created worker key. Use scoped keys for remote workers.

The repository Compose file publishes both web and PostgreSQL ports on every
interface. The starter stack publishes only web port `3000`.
Check `ports` entries before public deployment.
See [Public deployment](docs/getting-started/public-deployment.md).
