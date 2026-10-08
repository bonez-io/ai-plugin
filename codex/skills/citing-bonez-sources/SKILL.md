---
name: citing-bonez-sources
description: Cite and dereference Bonez results correctly. Use whenever you present or act on a finding that came from a Bonez tool, when a result carries a ~hex handle, when the user asks where a claim came from, or when you need the full record behind a search result.
---

# Citing Bonez sources

Every Bonez result identifies its entity by a **handle** — `~` followed by hex characters (e.g. `~a1b2c3d4`). It is the graph's citation token and valid **tool input**. Results print it already wrapped as a citation, `[label](~a1b2c3d4)`, and tell you so ("Cite as …"); copy that form instead of building your own.

## The rules

- **Never fabricate a handle.** Only use handles that appeared verbatim in a tool result this session. An invented or "remembered" handle fails dereference and poisons trust in every real citation around it. No handle at hand? Say plainly that you don't have a source.
- **Outside Bonez's own UI a `~hex` link is dead text.** When presenting to a person, say what the thing is by name and, if the fetched record carries a vendor URL (the ticket, PR or doc it came from), give them that too; keep the handle for your own follow-up calls.
- **Dereference with `graph_fetch`:**

```json
{"ref": "~a1b2c3d4", "description": "Reading the record behind the search hit"}
```

`ref` takes a handle, a node key, or a URL — `graph_fetch` is the one "read this node" door, and it reads memories too (`"ref": "m:…"`). An unresolvable ref comes back as `not_found` with guidance on the accepted forms; a memory you are not allowed to see answers exactly like a missing one.

- **A citation can outlive its code.** When a handle's code was renamed or removed, `graph_fetch` says so — where it moved, or which commit removed it — rather than a bare miss. That is not a bad handle: follow the new address, or `graph_search` for the behaviour.

## Provenance and staleness

A fetched record carries its properties, provenance, validity (`valid_from` / `valid_to`) and, for a memory, its current revision. Two consequences:

- When a snippet and the fetched record disagree, the fetched record wins.
- Surface staleness honestly: "decided in 2025-03, marked superseded" is a citation; presenting it as current policy is a fabrication with a source attached.

More depth when you need it: `"history": true` on a memory returns its full revision chain (author, date and reason of each revision); `graph_history` with a `ref` shows what changed on a node and in which commit; `at=<commit>` on a read shows the graph as it was; a memory attached to code is marked as changed when the code it describes has since moved — re-check before relying on it.
