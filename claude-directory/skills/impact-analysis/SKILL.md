---
name: impact-analysis
description: Measure the blast radius before a change lands. Use BEFORE you change, rename or delete a function, type, file or public contract that other code may use, when asked "what breaks if", "who calls this", "is it safe to change or delete this" or "what tests cover this", before a refactor of a shared symbol, and when judging how risky a diff or PR is. Do not wait to be asked.
---

# Impact analysis

The graph knows the org-wide dependency structure — including consumers in repos you don't have checked out. Use it before you change anything shared.

## Get the seed right first

A wrong seed silently analyzes the wrong thing. Resolve the exact symbol before traversing:

1. `graph_search` for it, narrowed to the symbol type once you have seen the type's name in `graph_schema` (code symbols are typically `Symbol`):

```json
{"text": "resolveTheme in the theme pipeline", "types": ["Symbol"], "limit": 5, "description": "Finding the exact symbol to analyse"}
```

2. `graph_fetch` the candidate. Confirm it is the symbol you mean — same repo, same file, same name — and read its `key` from the frontmatter: for a symbol that is its `path`, which is what the stored queries below take as `path`.

## The recipes

All through `graph_query(name=…, params=…)`. These stored queries ship in the Bonez catalog; confirm the names and parameters on your server with `graph_schema(find="callers")` (or `blast radius`, `tests`, `imports`) before relying on them. Each takes the seed `path` and an optional `repo` to narrow the result to one repository.

- **callers** — `callers_of_symbol`: symbols that call the seed. The first question, never the last. `callees_of_symbol` is the other direction.
- **blast radius** — there is no single "blast radius" query: it is arms you fuse yourself by node id. `blast_radius_calls` (incoming calls, one hop), `blast_radius_calls_two_hop` (incoming calls, two hops, with the path as evidence), `blast_radius_uses` (symbols within 1–2 incoming `Uses` hops) and, for a file seed, `blast_radius_imports` (files within 1–2 incoming `Imports` hops).
- **tests** — `tests_for_symbol`: symbols that test the seed, the minimum verification set for the change. `tests_of_symbol` is the reverse: what a test symbol covers.
- **importers** — `importers_of_file`: files that import the seed file, coarser than callers; right for "who uses this module". `imports_of_file` is the other direction.

```json
{"name": "blast_radius_calls", "params": {"path": "<symbol path>"}, "description": "Direct dependents of the symbol"}
```

## Depth traps

- **Direct callers are not the blast radius.** One level understates risk for any public symbol. Conversely, a full transitive closure on a hot utility explodes into thousands — summarize by module or repo instead of listing, and fetch only representatives.
- **Always report WHICH depth you measured.** "12 direct callers, ~300 within two hops across 4 repos" is an answer; "12 callers" alone is misleading.
- **No tests found means untested, not safe.** An empty `tests_for_symbol` raises the risk rating — say "no indexed tests cover this" and recommend adding one, never "safe, no tests affected".
- **Go cross-repo for shared code.** Leave `repo` off when the symbol is exported from a library — out-of-repo consumers are exactly what local grep can't see.
- **Call edges are candidates, not proof.** The call-graph stored queries describe themselves as candidate navigation: known shadowed bindings and low-confidence edges are excluded, heuristic and legacy rows stay visible with a verification status, and the `source_verified_*` variants only claim lexical import evidence. Dynamic dispatch, reflection, codegen and string-based wiring may be missing. Say so for symbols likely used that way, and never read an empty caller list as "dead code".
- **The graph is the indexed state of the code.** Your working tree and unpushed changes are not in it; note that when the change touches heavily in-flight code. `graph_history` shows what moved in the graph recently.

## When to stop

Enumerate dependents, cluster them, spot-check a few representatives with `graph_fetch` to confirm real usage. Full-fetching every dependent is never proportionate.

## Hand-offs

- Unknown names, or unexpected emptiness → `querying-the-graph` (schema-first rule).
- Presenting the analysis with sources → `citing-bonez-sources`.
