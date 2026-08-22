---
name: context
description: Mount and summarize your bonez org context — identity, org knowledge, standing rules, memories
argument-hint: [repo_id]
---

# /bonez:context

Run the `context` tool on the `bonez` MCP server and summarize the mount for the user.

1. Call the bonez `context` tool. If the user provided an argument, pass it as the scope; otherwise omit `scope` for the org-wide mount:

```json
{"scope": "$ARGUMENTS"}
```

(Omit the `scope` key entirely when "$ARGUMENTS" is empty.)

2. Summarize what came back, band by band, briefly:
   - **Identity** — who the graph says the caller is (name, teams, footprint).
   - **Knowledge** — the 3–5 most consequential org/repo facts mounted (decisions, gotchas).
   - **Rules** — the standing rules now in effect for this session; note that you will follow them.
   - **Memories** — how many are mounted and the few most relevant to the current work.

3. If any band returns an unavailable marker, report that band as unavailable — do not present a partial mount as complete, and do not treat a missing band as "none exist".

Keep the summary short: this is an orientation snapshot, not a document dump. The mounted content itself is now in context and will guide the rest of the session.
