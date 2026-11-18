---
name: finding-prior-art
description: Searches what the org already knows, in the System Model, before you build or decide. Use BEFORE you write non-trivial code, design an approach or choose a library, when the user asks "have we done this before", "why is X like this" or "has anyone hit this error", when a decision smells like it was already made once, or before you propose an approach someone may have rejected. Do not wait to be asked.
---

# Finding prior art

The org's hard-won knowledge — decisions, gotchas, incident lessons, owners — is in the System Model alongside its code and attached to it. Code alone won't show it, and rebuilding a rejected approach is the most expensive way to rediscover a decision.

## Workflow: search, then fetch

1. `system_model_search` with the question as `text`. Do not restrict `types` unless you know the exact names:

```json
{"text": "retry strategy for webhook delivery", "limit": 10, "description": "Looking for earlier decisions on webhook retries"}
```

Each result is a handle (`~hex`) with its type and its **attached-memory count**, so you know a memory exists on a record before you open it. Search finds records — code, docs, tickets, PRs, conversations, knowledge entries. It does not search memories directly: a memory is reached through the record it is anchored to.

2. `system_model_fetch` the top 2–3 handles before quoting anything:

```json
{"ref": "~a1b2c3d4", "description": "Reading the top hit and its attached memories"}
```

The fetched record carries its properties, provenance, validity, neighbours grouped by link type, and the memories attached to it — a memory whose code has since changed is marked as changed. Snippets are bait, not evidence; prefer the fetched record when they disagree.

3. To read one memory in full, or how it got to its current wording, `system_model_fetch` its `m:…` id (with `"history": true` for the revision chain: author, date and reason of each revision).

## Scope

Leave `types` off until you have seen the results: the allowed list is closed and differs per organization, and a record type that exists in the schema can still be refused by search when it is not indexed for it. Take names from `system_model_schema`, never from memory. Search spans the whole org — that is the point; prior art usually lives in a repo you are not looking at.

## Traps

- **Empty is not absence.** "No records matched" means nothing matched your phrasing. If the output says the page was cut off, that is not "nothing matched" either — raise `limit` (max 50) or narrow `types`. Vary the phrasing once (the domain word, the error text, the ticket vocabulary), then state coverage honestly: "nothing indexed under these terms", never "we've never done this".
- **A memory that is not there yet is not a memory that was never written.** Fresh memories start `pending` and only show up on their anchor once promoted (see `remembering`).
- **Prior art expires.** Check a fetched record's validity (`valid_to`) and any "changed" marker on an attached memory before presenting it as current. `system_model_history` with the record's `ref` shows what has changed on it and when; `at=<commit>` on a read shows the past.

## When to stop

Two searches with varied phrasing plus fetched top hits is proportionate diligence for most tasks. Escalate to `system_model_query` only when you have a concrete seed and need its neighbourhood — see `querying-the-system-model`.

## Hand-offs

- Relationship and impact questions ("what depends on this") → `impact-analysis`.
- "Who knows about this" → `who-owns-what`.
- Presenting what you found → `citing-bonez-sources`.
