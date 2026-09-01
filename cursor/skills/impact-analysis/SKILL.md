---
name: impact-analysis
description: Assess blast radius before changing code. Use when asked "what breaks if", "who calls this", "is it safe to change or delete this", "what tests cover this", before refactoring a shared symbol or changing a public contract, or when judging how risky a diff is.
---

# Impact analysis

The graph knows the org-wide dependency structure — including consumers in repos you don't have checked out. Use it before you change anything shared.

## Get the seed right first

A wrong seed silently analyzes the wrong thing. Resolve the exact symbol before traversing — `bonez:search` with the symbol entity:

```json
{"query": "resolveTheme in the theme pipeline", "entities": ["symbol"], "limit": 5}
```

or `bonez:fetch` by address (`repo_id/relative/path[:line]`, plus `symbol` to narrow a file). Confirm the result is the symbol you mean — same repo, same signature — then use its `~handle` as the seed.

## The recipes

All via `bonez:query`; the authoritative grammar and full recipe catalog live in the tool's own description — these are the judgment notes, not the syntax reference.

- **callers** — who invokes this symbol directly. The first question, never the last.

```json
{"q": "from ~a1b2c3d4 callers"}
```

- **blast_radius** — transitive dependents: the real "what breaks" answer.
- **tests_for** — tests exercising the symbol: the minimum verification set for the change.
- **importers** — module-level dependents, coarser than callers; right for "who uses this package".

## Depth traps

- **Direct callers are not the blast radius.** One level understates risk for any public symbol. Conversely, full transitive closure on a hot utility explodes into thousands — summarize by module or repo instead of listing, and fetch only representatives.
- **Always report WHICH depth you measured.** "12 direct callers, ~300 transitive across 4 repos" is an answer; "12 callers" alone is misleading.
- **No tests found means untested, not safe.** `tests_for` returning nothing raises the risk rating — say "no indexed tests cover this" and recommend adding one, never "safe, no tests affected".
- **Go cross-repo for shared code.** Omit `repos` when the symbol is exported from a library — out-of-repo consumers are exactly what local grep can't see.
- **The graph is static analysis.** Dynamic dispatch, reflection, codegen, and string-based wiring may be missing as edges. For symbols likely used dynamically, state the residual risk.
- **The graph indexes the default branch.** In-flight branches and uncommitted work are invisible; note it when the change targets heavily-in-flight code.

## When to stop

Enumerate dependents, cluster them, spot-check `bonez:fetch` a few representative ones to confirm real usage. Full-fetching every dependent is never proportionate.

## Hand-offs

- Unknown edge names or unexpected emptiness → `querying-the-graph` (schema-first rule).
- Presenting the analysis with sources → `citing-bonez-sources`.
