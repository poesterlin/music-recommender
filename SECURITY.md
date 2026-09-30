# Security

## Reporting a vulnerability

Use GitHub's private reporting: go to
[Security → Report a vulnerability](https://github.com/poesterlin/sole/security/advisories/new)
on this repository.

I offer no bug bounty or response-time guarantee.
Discuss publication timing in the private advisory.

## Data access

- **Your audio files.** The web process reads the library path mounted at
  `/music`. The embedding worker fetches bounded audio snippets over an authenticated endpoint on your
  deployment. A remote worker receives those snippets on its machine.
- **Your listening history.** Sole stores liked tracks and play events in PostgreSQL.

## Authentication model

See [Authentication and API key scopes](docs/reference/application.md#authentication).
The [route guard](web/src/hooks.server.ts) restricts bootstrap credentials.
Use a UI-created `worker` key for a remote worker.
Unlike `WORKER_TOKEN`, it cannot call the maintenance POST endpoints.

## Hardening a public deployment

- Keep PostgreSQL off the public internet. Check the optional Compose database's
  `ports` entry; an external `DATABASE_URL` should be reachable only from the
  deployment host and its containers.
