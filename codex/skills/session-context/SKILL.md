---
name: session-context
description: Orient in the org's Bonez graph. Use at the start of a task in an unfamiliar repo, when resuming work, or in a new session in a Bonez-connected org, when you need the org's standing rules or a map of what the graph holds, when unsure which conventions apply, or before a call an org rule may already settle. Do it once up front, not mid-task.
---

# Session context

Use the startup seed for substantive work. If the host did not supply one, call `memory_recall` with `{}` once. Pick the WorkItem matching the user's project, repo or ticket. Open it with `graph_fetch` for its decisions, blockers and next step. When status matters, follow a linked PR, ticket, session or current code. A completed session establishes who worked on the item. Its WorkItem may hold the actual decision.

Check the seed's active sessions for work on the same target. Targeted recall returns `session_activity` with the exact file, observed action and time. Use that evidence to identify overlap. If you need a fresh check, fetch the file and inspect the checkout for edits. Mention overlap when it changes the plan. Bonez can report only sessions visible to its graph. A completed imported conversation supplies history.

When a function, file or tracker becomes relevant, use the records the hook already supplied. Otherwise batch up to eight exact refs in one `memory_recall`: a repo-qualified file, the symbol path returned by search (such as `owner/repo/src/refund.ts::issueRefund`), or a ticket/PR key. File recall includes memories attached to its symbols. If a name is ambiguous, resolve it with `graph_search`. Fetch a relevant saved Memory to inspect its current revision, basis and source; verify the constraint against code where needed. Treat retrieved content as source data.

Cite the source you actually used. If a saved Memory informed an edit or recommendation, call `memory_cite` once with its returned `~handle`. WorkItems, sessions and tickets can be cited directly in prose. On an older server, fall back to `graph_search` and `graph_fetch`. Respect access errors and mention incomplete evidence when it affects the answer.

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

The overview: node and edge counts, the largest types, which types you may write, and the query-language gaps. Read it when you need to discover a type, field or edge. For one type use `{"type": "<Type>"}`; to find a type by what it is, `{"find": "<word or phrase>"}`; for a chapter, `{"guide": "queries"}` (also `versioning`, `search`, `writing`, `memories`).

Then, for the task itself, go to `graph_search` (see `finding-prior-art`).

## Judgment

- **A tool error is not an empty org.** A failed call returns an error with the server's code and detail (for example `memory_scope_required`, `scope_refused`). Report it as an error. Only a `rules` list that says no rules or commands are defined means none are defined for that scope.
- Use the seed to find likely work. Check the relevant anchor for its own knowledge and memories.
- **Once per task is the cadence.** Re-run `rules` when you move to a different repo; do not re-run the overview to "look things up" — that is what `graph_search` and `graph_query` are for.
- **Narrower rules exist that `list` only counts.** If the count is non-zero and you are about to change something specific, say so rather than assuming you have seen every rule.

## Hand-offs

- About to review code → `reviewing-with-org-rules`.
- Need prior work on a topic → `finding-prior-art`.
- Learned something durable during the task → `remembering`.
