---
name: search
description: Search your Bonez System Model — code, docs, tickets, PRs, conversations, people — in one query
argument-hint: <query>
---

# /bonez:search

Search the org's System Model for: **$ARGUMENTS**

1. Call the bonez `system_model_search` tool with the user's query. Leave `types` off — the allowed list is closed and different for each organization, and a guessed name is refused:

```json
{"text": "$ARGUMENTS", "limit": 10, "description": "Searching the System Model for what the user asked about"}
```

Narrow `types` only with names `system_model_schema` has shown you, and only if the user's phrasing clearly asks for it.

2. Present the ranked results compactly: label, record type, key, and the attached-memory count. Keep the `~hex` handles for follow-up calls; a handle is tool input, not a URL a person can open.

3. If the output says the search was cut off, say so — that is NOT "nothing matched". If nothing matched, say "no records matched these words" and offer one rephrasing; do not conclude the org knows nothing about it.

4. Offer the natural next step: `system_model_fetch` the top hit by its handle (its attached memories come with it), or pivot to `system_model_query` if the question is about relationships.
