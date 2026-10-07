---
name: session-context
description: Orient yourself in the org's Bonez graph at the start of work. Use when starting a session or a new task in a Bonez-connected org, when you need the org's standing rules or a map of what the graph holds, when unsure which conventions apply, or before a call an org rule may already settle.
---

# Session context

Bonez has no "mount everything" tool. You orient with two cheap reads at the START of a task — not mid-task after you have already guessed.

## 1. The standing rules — `rules`

```json
{"op": "list"}
```

Add `"repo_id": "<repo>"` for repo-scoped work. The answer is the org's mounted rules in full, a count of narrower rules pinned below repo scope (counted, not listed), and the org's slash commands. `{"op": "get", "urn": "<urn from the list>"}` expands one rule or command to its full body.

Rules are binding. Follow them the way you follow your agent instructions file (CLAUDE.md / AGENTS.md): they encode how THIS org works and outrank your generic defaults.

## 2. The map — `graph_schema` with no arguments

```json
{}
```

The overview: node and edge counts, the largest types, which types you may write, and the query-language gaps. Read it once so you stop guessing at type names. For one type use `{"type": "<Type>"}`; to find a type by what it is, `{"find": "<word or phrase>"}`; for a chapter, `{"guide": "queries"}` (also `versioning`, `search`, `writing`, `memories`).

Then, for the task itself, go to `graph_search` (see `finding-prior-art`).

## Judgment

- **A tool error is not an empty org.** A failed call returns an error with the server's code and detail (for example `memory_scope_required`, `scope_refused`). Report it as an error. Only a `rules` list that says no rules or commands are defined means none are defined for that scope.
- **Memories are not mounted.** There is no tool that lists them. They hang off the nodes they are about: `graph_search` shows a memory count per result and `graph_fetch` lists the attached memories. See `finding-prior-art`.
- **Once per task is the cadence.** Re-run `rules` when you move to a different repo; do not re-run the overview to "look things up" — that is what `graph_search` and `graph_query` are for.
- **Narrower rules exist that `list` only counts.** If the count is non-zero and you are about to change something specific, say so rather than assuming you have seen every rule.

## Hand-offs

- About to review code → `reviewing-with-org-rules`.
- Need prior work on a topic → `finding-prior-art`.
- Learned something durable during the task → `remembering`.
