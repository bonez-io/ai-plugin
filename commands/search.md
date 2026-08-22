---
name: search
description: Search the bonez context lake — code, decisions, tickets, PRs, docs, people — in one fused query
argument-hint: <query>
---

# /bonez:search

Search the org's context lake for: **$ARGUMENTS**

1. Call the bonez `search` tool with the user's query. Default to the broad entity set — org knowledge is indexed alongside code:

```json
{"query": "$ARGUMENTS", "limit": 10}
```

Narrow `entities` (e.g. `["symbol"]`, `["ticket", "pr"]`) or add `repos` only if the user's phrasing clearly asks for it.

2. Present the ranked results compactly: title, one-line snippet, entity kind, and the vendor URL as the link (handles like `~a1b2c3d4` are tool input, not links — keep them for follow-ups, cite URLs to the human).

3. If the result set carries `[INCOMPLETE]` markers or an unavailable-arm notice, say so: coverage was partial, absence proves nothing.

4. Offer the natural next step: fetch the full record behind the top hit (bonez `fetch` with its handle), or pivot to a graph traversal if the question is relational.
