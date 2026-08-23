---
description: Search the bonez context lake — code, decisions, tickets, PRs, docs, people — in one fused query
argument-hint: <query>
---

Search the org's context lake for: **$ARGUMENTS**

Call the bonez MCP `search` tool with the query. Default to the broad entity
set — org knowledge is indexed alongside code:

```json
{"query": "$ARGUMENTS", "limit": 10}
```

Narrow `entities` (e.g. `["symbol"]`, `["ticket", "pr"]`) or add `repos`
only if the phrasing clearly asks for it.

Present the ranked results compactly: title, one-line snippet, entity kind,
and the vendor URL as the link (handles like `~a1b2c3d4` are tool input, not
links — keep them for follow-ups, cite URLs to the human).

If the result set carries `[INCOMPLETE]` markers or an unavailable-arm
notice, say so: coverage was partial, absence proves nothing.

Offer the natural next step: fetch the full record behind the top hit
(bonez `fetch` with its handle), or pivot to a graph traversal if the
question is relational.
