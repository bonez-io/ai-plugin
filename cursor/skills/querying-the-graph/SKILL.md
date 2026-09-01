---
name: querying-the-graph
description: Traverse the org graph with BGQ via bonez:query. Use when a question is about relationships or structure — what calls, imports, tests, or depends on X, what is connected to a ticket or PR, which code touches a table — or when search has found a seed and you need its neighborhood.
---

# Querying the graph

`bonez:query` runs BGQ — the org's graph query language — over the whole indexed org: code symbols, files, PRs, tickets, docs, people, knowledge, and the edges between them.

## The loop

**`bonez:search` → `bonez:schema` → `bonez:query` → `bonez:fetch`**

1. `search` finds seeds by intent when you don't have one.
2. `schema` tells you the graph's real shape when you don't know it.
3. `query` traverses.
4. `fetch` dereferences result handles into full records.

## The one hard rule: never guess node types or edges

The ontology is data, not convention. An invented edge or node type doesn't error — it returns empty, and empty looks exactly like "no results". If you are not certain of the shape, call `bonez:schema` FIRST:

```json
{"search": "how are pull requests linked to tickets"}
```

or exact-lookup what you think you know:

```json
{"node_types": ["github/pull_request", "ticket"], "edges": ["PART_OF"]}
```

## Writing queries

The authoritative BGQ grammar and the recipe catalog (callers, blast radius, tests-for, importers, data access, knowledge-for, …) live in the `bonez:query` tool description — read it there; it is updated server-side and outranks anything remembered here. Seeds accept `~handles` straight from `search`/`fetch` results:

```json
{"q": "from ~a1b2c3d4 callers", "repos": ["harness-ui"]}
```

## Judgment

- **Empty result + unverified schema = suspect the query, not the graph.** Verify the shape with `schema`, correct, retry once. Only then report emptiness — and report it as "this traversal found nothing", not "nothing exists".
- **Scope deliberately.** Omitting `repos` queries the whole org — that is the superpower (cross-repo edges grep can't see) and the noise source. Narrow to the working repo for repo-local questions.
- **The graph lags your working tree.** `ref` pins a branch/commit; the default is the indexed default branch. Uncommitted or just-pushed changes are invisible — for "what does the code say right now", read the file; for "how is the org wired", query the graph.
- **Big traversals need summarizing.** Hundreds of results are a distribution, not a list — report counts and clusters, fetch only representatives.

## Hand-offs

- Change-safety questions with ready-made recipes → `impact-analysis`.
- No seed yet → `finding-prior-art` for the search-first workflow.
