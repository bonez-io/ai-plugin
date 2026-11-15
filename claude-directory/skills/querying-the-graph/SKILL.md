---
name: querying-the-graph
description: Traverses the System Model with BGQ via system_model_query. Use when a question is about relationships or structure (what calls, imports, tests or depends on X, what is connected to a ticket or PR, which code touches a table), when you would otherwise grep across repos to trace callers or dependencies, or when system_model_search has found a seed and you need its neighbourhood.
---

# Querying the System Model

`system_model_query` runs BGQ — the System Model's query language — read-only, over the whole organization: code symbols, files, PRs, tickets, docs, people, and the links between them.

## The loop

**`system_model_search` → `system_model_schema` → `system_model_query` → `system_model_fetch`**

1. `system_model_search` finds seeds by intent when you don't have one.
2. `system_model_schema` tells you the System Model's real shape — record types, fields, link types and the stored queries — when you don't know it.
3. `system_model_query` traverses, with a stored catalog query by `name` or a hand-written BGQ `query`.
4. `system_model_fetch` dereferences result handles into full records.

## The one hard rule: never guess record type, field, link type or query names

The vocabulary is data, not convention. Call `system_model_schema` first whenever the exact name is not already in front of you:

- no arguments — the overview of what the System Model holds;
- `{"type": "Ticket"}` — one record type's properties (with nullability) and its link types in each direction;
- `{"find": "merge request"}` — the matching sub-schema plus 2–3 stored queries as worked examples (a word or phrase, not a list of type names);
- `{"guide": "queries"}` — the generated BGQ chapter (`versioning`, `search`, `writing`, `memories` are the others).

## Two ways to call `system_model_query`

Pass exactly one of `name` or `query`.

**Start from the catalog, not from a scan.** `system_model_schema(find=<what you are tracing>)` lists the stored queries that fit and how to run them:

```json
{"name": "callers_of_symbol", "params": {"path": "<symbol path>"}, "description": "Who calls refund_charge"}
```

**Hand-written BGQ** is for what no stored query covers, and it should filter on a value you already know rather than read a whole type. It must be a complete definition, and the name takes parentheses ALWAYS, even with no parameters:

```json
{"query": "query seed($path: String) { match { $s: Symbol { path: $path } $c: Symbol $c calls $s } return { $c.path, $c.name, $c.handle } limit 50 }", "params": {"path": "<symbol path>"}, "description": "Direct callers of one symbol"}
```

`query open_tickets {` (no `()`) is a parse error whose engine message does not say so. Mutations are refused.

Always send `description`: a short plain-language note of what you are fetching and why. Keep query syntax and handles out of it.

Other arguments: `at` (a commit id) reads the past; `limit` caps the rows you get back (default 50, max 500) and is a DIFFERENT limit from the one written inside a BGQ query, which is the engine's own row budget.

## BGQ pitfalls that bite most often

- Link verbs are lowerCamelCase in a query even though the schema declares them PascalCase (`$c calls $s`, `aboutSymbol`).
- Hops: `$a calls{1,3} $b` — annotate BOTH endpoint records before the hop count.
- Negation: `not { $bound edge $_ }` — the already-bound variable stays in source position and the fresh endpoint is a BARE `$_`. A typed `$_: Kind` fails in the engine.
- `bm25(...)` / `nearest(...)` must LEAD the `order` clause and need a trailing literal `limit N` — never a parameter.
- No `or`, no `in`, no null test, and `limit` takes an integer literal only. Two disjoint slices are two queries; an optional parameter uses the `not { $x != $p }` double-negative.
- A row whose column ends in `.handle` is rendered as a citation you can pass to `system_model_fetch` — project `$n.handle` yourself when you want a citable result.
- **Memories cannot be queried.** A query that names a memory type, or any link type that touches one, is refused with `scope_refused` — and so is a stored query that reads them. Read memories only through `system_model_search` (counts) and `system_model_fetch`.
- Errors come back as the engine's own code and message, naming the offending clause. Correct it and retry from the hint; do not guess again from scratch.

## Judgment

- **Empty is labelled, not silent.** A valid query that matches nothing says "valid query, no rows" with hints (equality is case-sensitive, NULL never matches a predicate, keys are fully scope-qualified). That means your predicate is wrong or the data is not there — not that the thing does not exist. A *failed* query is an error. Never read either as proof of absence.
- **Scope deliberately.** A query with no repo filter spans the whole org — that is the superpower (cross-repo links grep can't see) and the noise source. Many code-navigation stored queries take an optional `repo`.
- **Big results need summarizing.** Hundreds of rows are a distribution, not a list — report counts and clusters, fetch only representatives. Very large output is truncated with an explicit marker; narrow the query rather than paging blindly.

## Hand-offs

- Change-safety questions with ready-made recipes → `impact-analysis`.
- No seed yet → `finding-prior-art` for the search-first workflow.
