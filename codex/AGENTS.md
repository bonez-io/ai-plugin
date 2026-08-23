# Working with bonez

This org is connected to bonez — a knowledge graph over its repos, tickets,
PRs, docs, conversations, and people, served over MCP as the `bonez` server
(`search`, `schema`, `query`, `fetch`, `context`, `memory`, `rules`).

## Start of task

Call `context` once at the start of non-trivial work (`{"scope": "<repo_id>"}`
for repo-scoped work, omitted for org-wide). It mounts the same
identity/knowledge/rules/memories bands bonez's own agents boot with — read
before guessing, and before a call an org rule may already settle.

## Before building or deciding

Search before you build: `search` the question as intent, entities left broad
(`knowledge`, `memory`, `ticket`, `pr`, `doc`, not just `symbol`) — omit
`repos` to search the whole org, since prior art usually lives outside the
repo you're in. `fetch` the top 2-3 handles before quoting anything; snippets
are bait, the fetched record carries provenance and temporal status and wins
on disagreement. `[INCOMPLETE]` markers or an unavailable-arm notice mean a
coverage gap, not absence — say so, don't present a partial answer as
complete. "No results" proves nothing was indexed under that phrasing, not
that the org never did it.

## Querying the graph

Loop: `search` for a seed → `schema` when the shape is unknown → `query`
(BGQ) to traverse → `fetch` to dereference. **Never guess node types or edge
names** — an invented one doesn't error, it returns empty, which looks
exactly like "no results." Call `schema` first when unsure.

For change-safety questions (what breaks, who calls this, is it safe to
change), use `query` recipes callers → blast_radius → tests_for. Direct
callers are not the blast radius; report which depth you measured. No tests
found means untested, not safe — say "no indexed tests cover this," never
"safe." Omit `repos` for anything exported from a shared library —
out-of-repo consumers are exactly what local grep can't see.

## Citing results

Every result carries a `~hex` handle (graph citation token, valid as tool
input, dead text to a human) and a vendor URL (the link for humans). Cite the
vendor URL to people; keep the handle for follow-up `fetch` calls. **Never
fabricate a handle** — only reuse one that appeared verbatim in a tool result
this session.

## Memory (`memory` tool)

`recall` freely. `save`/`update`/`delete` write durable facts into every
future session in the org — do it the moment you learn something durable
(a correction, a convention, a non-obvious gotcha), not as cleanup. Pick
`layer: personal` (about the user) or `org`, and `temporality: static` or
`temporal`. Never store secrets/credentials or sensitive personal data.
Don't store one-off task details or anything re-derivable from code — store
the *why*, not the raw fact. `update` supersedes; never duplicate.

## Rules (`rules` tool)

`list`/`get` freely — these are the org's standing, binding instructions;
follow them the way you follow this file, and they outrank generic defaults.
`save`/`update`/`delete` change guidance mounted into every session for the
whole org — write conservatively, confirm with the user first, and expect
this to need a `read+write` key.

**No write confirmation gate in this Codex setup.** Claude Code ships a
`PreToolUse` hook here that pauses for interactive approval before any
`memory`/`rules` write. Codex has no equivalent: a `PreToolUse` hook can only
unconditionally allow or deny a call, not pause for a yes/no prompt (`ask` is
parsed but unimplemented — see the repo README's Codex section). Treat every
`rules` write as already-approved before you make it, and prefer proposing
the change in chat over calling `save`/`update`/`delete` unprompted.
