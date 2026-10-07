---
description: Orient in your Bonez graph — what it holds, the standing rules in effect, and (optionally) what it knows about a repo or topic
---

Orient the user in their Bonez graph and load the standing rules. Two reads, plus one optional search.

1. Call the bonez `graph_schema` tool with no arguments. This is the overview: node and edge counts, the largest types, which types may be written, and the query-language gaps.

2. Call the bonez `rules` tool to load the standing rules:

```json
{"op": "list"}
```

If the user passed an argument after the command and it names a repository, add it as `"repo_id"` to scope the mount.

3. If the argument is a topic rather than a repository, also call `graph_search` with it as `text` (`limit` 10). Note each result's attached-memory count — a non-zero count means there is a gotcha or decision to read with `graph_fetch`.

4. Summarize briefly:
   - **What the graph holds** — the largest types and what they are, in a sentence or two.
   - **Rules** — the standing rules now in effect for this session; say that you will follow them. Mention how many narrower rules are pinned below repo scope (`list` counts them but does not show them).
   - **Hits** (only if you searched) — the few most relevant results, with their memory counts.

5. Report failures as failures. A tool error means that part could not be read; do not present a partial orientation as complete. Only a `rules` answer saying no rules or commands are defined means none exist for that scope.

Keep it short: this is an orientation snapshot, not a document dump. Memories are not mounted — they are attached to the nodes they describe, and you reach them through `graph_search` and `graph_fetch`.
