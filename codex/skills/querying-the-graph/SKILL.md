---
name: querying-the-graph
description: Traverse the org graph with BGQ via bonez:query. Use when a question is about relationships or structure — what calls, imports, tests, or depends on X, what is connected to a ticket or PR, which code touches a table — or when search has found a seed and you need its neighborhood.
---

# Querying the graph

`bonez:query` runs BGQ — the org's graph query language — over the whole indexed org: code symbols, files, PRs, tickets, docs, people, memories, and the edges between them, via the live graph engine.

## The loop

**`bonez:search` → `bonez:schema` → `bonez:query` → `bonez:fetch`**

1. `search` finds seeds by intent when you don't have one.
2. `schema` tells you the graph's real shape — node/edge types and every available `preset` — when you don't know it.
3. `query` traverses, either with a hand-written BGQ query or a named `preset`.
4. `fetch` dereferences result handles into full records.

## The one hard rule: never guess node types, edges, or preset names

The ontology is data, not convention. An invented edge or node type doesn't error the way you'd expect — it returns nothing, and nothing looks exactly like "no results". If you are not certain of the shape, call `bonez:schema` FIRST:

```json
{"search": "how are pull requests linked to tickets"}
```

or exact-lookup what you think you know:

```json
{"node_types": ["Ticket", "PullRequest"], "edges": ["Addresses"]}
```

or list what a preset actually does before calling it:

```json
{"presets": ["callers", "search_ticket"]}
```

## Two ways to call `query`

Pass exactly one of `q` (a complete, hand-written BGQ query) or `preset` (a catalog name).

**Presets** are the fast path for the common cases — a curated set of code-navigation traversals (`callers`, `callees`, `references`, `implementations`, `type_hierarchy`, `members`, `imports`, `importers`, `handlers`, `tests_for`, `http_callgraph`, `channels`, `data_access`, `config_for`, `knowledge_for`, `exception_flow`, `decorators`, `blast_radius`, `call_hierarchy`) plus a `search_<kind>` preset per entity kind (`search_symbol`, `search_ticket`, `search_pr`, ...) and any other catalog query by its exact name (e.g. `me_bonez`). `schema` with no arguments lists every one, with its params:

```json
{"preset": "callers", "params": {"path": "src/billing.py::charge", "repo": "bonez-io/bonez-gateway"}}
```

**Raw `q`** is a complete BGQ query definition for anything a preset doesn't cover:

```json
{"q": "query seed($path: String) { match { $s: Symbol { path: $path } $c: Symbol $c calls $s } return { $c.path, $c.name, $c.handle } limit 50 }", "params": {"path": "src/billing.py::charge"}}
```

## Writing raw BGQ

The authoritative grammar lives in the `bonez:query` tool description — read it there; it is updated server-side and outranks anything remembered here. The pitfalls that bite most often:

- `query name($p: Type) { match {...} return {...} }` — the parentheses are mandatory even with zero params.
- Edge verbs are lowerCamelCase in a query even though the schema declares them PascalCase (`$pr addresses $t`).
- Hops: `$a calls{1,4} $b` — annotate BOTH endpoint nodes before the hop-count braces.
- Negation: `not { $bound edgeVerb $_ }` — the already-bound var stays in SOURCE position; the fresh endpoint is a BARE `$_` (a typed `$_: Kind` 500s the engine).
- `bm25(...)`/`nearest(...)` must LEAD the `order` clause and need a trailing literal `limit N` (never a `$param`).
- No OR / no union — `match` is conjunctive-only. Write two queries (or two presets) for an either/or question.
- A row whose column ends in `.handle` gets a synthetic `~<handle>` citation you can hand to `fetch` — project `$n.handle` yourself when you want a citable result (every node type carries one, nullable).
- Errors come back as the engine's own structured code + message, naming the offending clause directly — correct it and retry from the hint, never guess again from scratch.

## Judgment

- **Empty result + unverified schema = suspect the query, not the graph.** Verify the shape with `schema`, correct, retry once. Only then report emptiness — and report it as "this traversal found nothing", not "nothing exists".
- **Scope deliberately.** A raw query with no repo filter spans the whole org — that is the superpower (cross-repo edges grep can't see) and the noise source. Most code_nav presets take an optional `repo` param; narrow to it for repo-local questions.
- **Big traversals need summarizing.** Hundreds of rows are a distribution, not a list — report counts and clusters, fetch only representatives.

## Hand-offs

- Change-safety questions with ready-made recipes → `impact-analysis`.
- No seed yet → `finding-prior-art` for the search-first workflow.
