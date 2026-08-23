---
name: session-context
description: Mount the org's context at the start of work. Use when starting a session or a new task in a bonez-connected org, when you need the org brief, standing rules, or team memories, when unsure which conventions apply, or before making a call that an org rule may already settle.
---

# Session context

Call `bonez:context` at the START of a task — not mid-task after you have already guessed. It returns the same mount the org's own first-party agents boot with, so you begin with the org's brain instead of reconstructing it.

```json
{"scope": "harness-ui", "include": ["identity", "knowledge", "rules", "memories"]}
```

- `scope` — a repo id for repo-scoped work; omit it for the org-wide mount.
- `include` — defaults to everything; narrow it only when you know exactly which band you need.

## What the bands mean

- **identity** — who the caller is in the graph: their user node, teams, and footprint. Ground any "me"/"my" question here instead of guessing from git config.
- **knowledge** — distilled org and repo knowledge: decisions, gotchas, architecture notes. This is curated signal, not raw search results.
- **rules** — the org's standing instructions (repo rules, review rules, commands). Follow them the way you follow AGENTS.md: they encode how THIS org works and outrank your generic defaults.
- **memories** — durable facts the org's agents have accumulated, personal and org layer, pre-filtered to the same set bonez's own agents mount. Treat them as established context, not hypotheses.

## Judgment

- `context` is a mount, not a search. For a specific question, use `bonez:search`; for a relationship, `bonez:query`. Calling `context` repeatedly to "look things up" wastes tokens on re-mounting.
- Once per task is the default cadence. Re-call only when the scope changes (you move to a different repo) or the session is long enough that staleness matters.
- A band returned with an unavailable marker (e.g. `[bonez] rules unavailable`) is an outage, not an empty org. Say the band was unavailable — never conclude "this org has no rules".
- An empty `memories` band in a young org is normal. Don't pad it by treating search results as memories.

## Hand-offs

- About to review code → `reviewing-with-org-rules` (rules band, applied).
- Need prior work on a topic → `finding-prior-art`.
- Learned something durable during the task → `remembering`.
