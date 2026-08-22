---
name: who-owns-what
description: Find people — owners, experts, reviewers — through the org graph. Use when asked who owns, maintains, or knows a system, who to ask, assign, or request review from, who wrote or decided something, or when routing work to a human.
---

# Who owns what

People are first-class nodes in the graph, with identities linked across vendors (GitHub, Jira, Slack, …) — one human = one identity. Ownership questions are graph questions.

## Workflow

1. Find the person or the artifact with `bonez:search`:

```json
{"query": "payments service owner", "entities": ["user", "person"], "limit": 5}
```

2. Traverse with `bonez:query` from either end — from an artifact toward its authors/reviewers/deciders, or from a person toward what they touch. The grammar and people-edge names live in the `bonez:query` tool description; check `bonez:schema` before guessing person-related edges.

3. `bonez:fetch` the person record before naming them — don't guess emails or handles.

## Judgment

- **Ownership is behavioral, not titular.** Authority topology — who reviews, who merges, who gets asked — beats last-commit-wins. A recent PR author may be a drive-by contributor; the person who reviewed the last ten PRs in that directory is the owner-shaped signal.
- **Exclude bots.** Bot accounts author enormous volumes of commits and comments. Never nominate a bot as an owner or expert; discount bot activity when weighing evidence.
- **Identity linking can be incomplete.** Two similar-looking "people" (a GitHub login and a Jira account, say) may be one unlinked human. When the evidence splits oddly across near-duplicate identities, consider merging it mentally and say the identities may be unlinked.
- **People go stale faster than code.** People leave; teams reorganize. Check the recency of the evidence before assigning — a two-years-ago expert may be gone. Prefer "most recent sustained activity" over "most total activity".
- **Small orgs, small graphs.** With few indexed people, the top result may be the only candidate, not the best one. Report the strength of the evidence, not just the name.

## Hand-offs

- "Why was this decided" (rather than "who decided") → `finding-prior-art`.
- Presenting a person with their evidence → `citing-bonez-sources` (vendor profile URL, not a bare handle).
