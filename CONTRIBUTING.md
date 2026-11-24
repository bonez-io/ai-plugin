# Contributing

## This repository is public

Everything here is public: the files, every commit message, branch name, pull request title and body, and the
whole history. Write for an outside reader.

- **No internal references.** Leave out issue-tracker ids and links, private repository names, customer or demo
  organization names, staff names, internal hosts and environments, cloud account ids, resource names and secret
  paths, and backend-only setting names. Describe the behaviour instead: "a self-hosted Bonez server whose sign-in
  uses a different Auth0 tenant", not the name of one of ours.
- **No secrets, real or fake-looking.** Test fixtures build token-shaped strings at run time (see
  `tests/session_sync.test.mjs`). A credential that reaches a commit must be rotated: removing it from the tree, or
  even from history, does not take it back.
- **Public OAuth client ids are not secrets** and may appear (`qFX0bzskdcDBhbJaBBwGoiLN5yWkBrMm` is the public
  Bonez CLI client).

CI enforces this in `.github/workflows/public-hygiene.yml`:

- `scripts/check-public-hygiene.mjs` checks every tracked file, the pull request's title and body, and the
  messages of its commits against a deny-list. Run it locally with `node scripts/check-public-hygiene.mjs`.
- gitleaks (`.gitleaks.toml`) scans the tree and the pull request's commits for secrets.

A hit that has to stay, because removing it would change behaviour, goes in `.public-hygiene-allow`, one line per
file, with the reason. Keep that list short.

## Development

See [Development](README.md#development) in the README for the tests and gates.
