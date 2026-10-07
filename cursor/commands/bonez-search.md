---
description: Search your Bonez graph — code, docs, tickets, PRs, conversations, people — in one query
---

Search the org's graph for whatever the user typed after the command.

1. Call the bonez `graph_search` tool with that query. Leave `types` off — the allowed list is closed and per-graph, and a guessed name is refused:

```json
{"text": "<the argument>", "limit": 10, "description": "Searching the graph for what the user asked about"}
```

Narrow `types` only with names `graph_schema` has shown you, and only if the user's phrasing clearly asks for it.

2. Present the ranked results compactly: label, node type, key, and the attached-memory count. Keep the `~hex` handles for follow-up calls; a handle is tool input, not a link a person can open.

3. If the output says the search was cut off, say so — that is NOT "nothing matched". If nothing matched, say "no nodes matched these words" and offer one rephrasing; do not conclude the org knows nothing about it.

4. Offer the natural next step: `graph_fetch` the top hit by its handle (its attached memories come with it), or pivot to `graph_query` if the question is about relationships.
