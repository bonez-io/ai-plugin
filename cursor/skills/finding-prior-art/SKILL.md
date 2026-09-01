---
name: finding-prior-art
description: Find what the org already knows before building or deciding. Use when starting non-trivial implementation or design work, when asked "have we done this before", "why is X like this", or "has anyone hit this error", when a decision smells like it was already made once, or before proposing an approach someone may have already rejected.
---

# Finding prior art

The org's hard-won knowledge — decisions, gotchas, incident lessons, owners — is indexed alongside its code. Code alone won't show it, and rebuilding a rejected approach is the most expensive way to rediscover a decision.

## Workflow: search, then fetch

1. `bonez:search` with the question as intent. Don't restrict `entities` to code when the question is a "why" or a "have we":

```json
{"query": "retry strategy for webhook delivery", "entities": ["knowledge", "memory", "ticket", "pr", "doc"], "limit": 10}
```

2. `bonez:fetch` the top 2–3 handles before quoting anything:

```json
{"ref": "~a1b2c3d4"}
```

Snippets are bait, not evidence. The fetched record carries provenance and temporal status (superseded? stale? what evidence backs it?) — prefer it over the snippet whenever they disagree.

## Scope

Omit `repos` to search the whole org — that is the default and the point: prior art usually lives in a repo you are not looking at. Pass the working repo only when the question is genuinely repo-local.

## Traps

- **`[INCOMPLETE]` markers and unavailable-arm notices mean coverage gaps, not absence.** Search is fused from several arms; when one arm reports unavailable, results are partial. Say so explicitly instead of presenting a partial answer as complete.
- **Absence is not proof.** "No results" never proves the org hasn't done it — it proves nothing was indexed under your phrasing. Vary the phrasing once (the domain word, the error text, the ticket vocabulary), then state coverage honestly: "nothing indexed under these terms", not "we've never done this".
- **Prior art expires.** A fetched decision may be superseded — check its temporal status before presenting it as current policy.

## When to stop

Two searches with varied phrasing plus fetched top hits is proportionate diligence for most tasks. Escalate to `bonez:query` traversal only when you have a concrete seed entity and need its neighborhood — see `querying-the-graph`.

## Hand-offs

- Relationship and impact questions ("what depends on this") → `impact-analysis`.
- "Who knows about this" → `who-owns-what`.
- Presenting what you found → `citing-bonez-sources`.
