---
description: Search your Bonez graph — code, docs, tickets, PRs, conversations, people — in one query
argument-hint: <query>
---

Search the org's graph for: **$ARGUMENTS**

Call the bonez MCP `graph_search` tool with the query. Leave `types` off — the
allowed list is closed and per-graph, and a guessed name is refused:

```json
{"text": "$ARGUMENTS", "limit": 10, "description": "Searching the graph for what the user asked about"}
```

Narrow `types` only with names `graph_schema` has shown you, and only if the
phrasing clearly asks for it.

Present the ranked results compactly: label, node type, key, and the
attached-memory count. Keep the `~hex` handles for follow-up calls; a handle
is tool input, not a link a person can open.

If the output says the search was cut off, say so — that is NOT "nothing
matched". If nothing matched, say "no nodes matched these words" and offer one
rephrasing; do not conclude the org knows nothing about it.

Offer the natural next step: `graph_fetch` the top hit by its handle (its
attached memories come with it), or pivot to `graph_query` if the question is
about relationships.
