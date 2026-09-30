# Security

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: go to
[Security → Report a vulnerability](https://github.com/poesterlin/sole/security/advisories/new)
on this repository. That opens a private advisory visible only to the maintainer.

Please include what you found, how to reproduce it, and the impact you believe it
has. There is no bug bounty and no SLA — this is one person's spare time — but a
credible report will be acknowledged and fixed, and you are welcome to publish
once a fix has shipped.

## What this software holds

Sole runs on your hardware and points at your music library, so it is worth
knowing what it can reach:

- **Your audio files.** The web process reads the library path mounted at
  `/music`. It does not upload your library anywhere. The embedding worker fetches
  bounded, time-limited audio *snippets* over an authenticated endpoint on your
  own deployment, not from a third party.
- **Your listening history.** Liked tracks and play events are stored in your own
  PostgreSQL and nowhere else.
- **Scoped API credentials.** See below.

## Authentication model

- The UI uses database-backed accounts and an opaque session cookie. Passwords are
  hashed; sessions are server-side and revocable.
- Self-registration is **off** by default and the account limit is `MAX_USERS=1`.
  Enable it with `ALLOW_REGISTRATION=true` and a deliberate limit.
- Two bootstrap credentials exist for Compose and unattended jobs:
  `WORKER_TOKEN` and `PLAYBACK_API_KEY`. Each is scoped to exactly one surface —
  `WORKER_TOKEN` is accepted only by `/api/worker/*`, and `PLAYBACK_API_KEY` only
  by the playback POST. Neither is accepted by ordinary application routes.
- Keys created in the UI under **API keys** are narrower still and are stored only
  as a hash. The secret is shown once and cannot be recovered, only reissued.
  Revoking one does not affect the account or any other key.

If you publish a deployment, treat `POSTGRES_PASSWORD`, `WORKER_TOKEN`,
`PLAYBACK_API_KEY` and any session secret as credentials. Generate them
(`openssl rand -hex 32`), keep `.env` at mode `600`, and never commit it.

## Hardening a public deployment

- Put it behind TLS. Reverse-proxy the web service; do not expose it directly.
- Keep `ALLOW_REGISTRATION` off unless you want strangers creating accounts.
- Leave `MAX_USERS` at 1 unless you have a reason not to.
- Use UI-created scoped keys for external workers instead of handing out the
  bootstrap `WORKER_TOKEN`.
- Keep PostgreSQL off the public internet. The optional Compose database binds to
  localhost; an external `DATABASE_URL` should be reachable only from the
  deployment host and its containers.
