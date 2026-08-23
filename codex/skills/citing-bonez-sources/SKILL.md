---
name: citing-bonez-sources
description: Cite and dereference bonez results correctly. Use when presenting findings that came from bonez tools, when a result carries a ~hex handle or vendor URL, when the user asks where a claim came from, or when you need the full record behind a search snippet.
---

# Citing bonez sources

Every bonez result identifies its entity two ways:

- a **handle** — `~` followed by 8–32 hex characters (e.g. `~a1b2c3d4`): the graph's citation token, and valid **tool input**;
- a **vendor `href`** — the real GitHub/Jira/Linear/docs URL behind the entity: the link for **humans**.

## The rules

- **Handles are tool input, not links.** Outside bonez's own UI, a `~hex` renders as dead text. When presenting to the user, cite the vendor URL (or the address); keep the handle for follow-up tool calls.
- **Never fabricate a handle.** Only use handles that appeared verbatim in a tool result this session. An invented or "remembered" handle fails dereference and poisons trust in every real citation around it. No handle at hand? Cite the address or vendor URL — or say plainly that you don't have a source.
- **Dereference via `bonez:fetch`:**

```json
{"ref": "~a1b2c3d4"}
```

`ref` also accepts vendor URLs, URNs, and addresses — `fetch` is the one "give me the thing" door.

- **Addresses are `repo_id/relative/path[:line]`.** Repo id first, path relative to that repo's root, optional line. Narrow a file to one symbol with `symbol`, or pull raw content with `lines`:

```json
{"ref": "harness-ui/packages/bonez/src/tool/registry.ts:42", "symbol": "ToolRegistry"}
```

## Provenance and staleness

Fetched records carry provenance (where the fact came from, its evidence chain) and temporal status (`valid_to`, superseded-by, staleness). Two consequences:

- When a snippet and the fetched record disagree, the fetched record wins.
- Surface staleness honestly: "decided in 2025-03, marked superseded" is a citation; presenting it as current policy is a fabrication with a source attached.
