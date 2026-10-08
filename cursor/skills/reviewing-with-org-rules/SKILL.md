---
name: reviewing-with-org-rules
description: Review code against the org's standing rules. Use when asked to review a PR, diff or change in a Bonez-connected org, when asked whether code follows the org's conventions, before you tell the user a non-trivial change is ready, and before approving, merging or signing off on anything non-trivial. Pull the rules first, then review.
---

# Reviewing with org rules

A review that applies only generic taste misses the point in an org with standing rules: the org has already decided how it wants its code to look, ship, and fail. Pull those decisions first; then review.

## Before reading the diff

Pull the org's standing rules with `rules`, scoped to the repo under review:

```json
{"op": "list", "repo_id": "<repo_id>"}
```

The answer is the rules in full (your review checklist's spine), a count of narrower rules pinned below repo scope (counted, not listed), and the org's slash commands. `{"op": "get", "urn": "<urn>"}` expands one to its full body.

Then look for the decisions and gotchas on the code being touched: `graph_search` the touched area (file path, symbol, ticket key), and `graph_fetch` the relevant hits — their attached memories are the difference between "weird code" and "deliberate code".

## Judgment

- **Org rules outrank your defaults.** Flag violations of THEIR rules before stylistic preferences. When a rule contradicts what you'd normally suggest, the rule wins — and cite it, so the author sees it's the org speaking, not you.
- **Run the deliberate-weirdness check.** Before flagging something odd, look for the decision that explains it. If a decision explains it, don't flag it; cite the decision instead. Re-litigating settled decisions is review noise.
- **Search the touched area for known gotchas.** A past incident or documented trap in the exact file being changed is the single highest-value review comment you can make (`finding-prior-art` workflow, scoped to the diff's files).
- **No rules listed is not the same as a failed lookup.** If `rules` returns an error, the review ran without org rules — say so in the review summary rather than silently reviewing on taste alone. If it says no rules are defined for the scope, say that instead.
- **Rules are editable, not just readable.** A stale or wrong standing rule is a finding too: propose the fix through `rules` (`update` takes the rule's `urn` and merges the fields you pass; saving the same name supersedes it; `delete` expires it as a tombstone — history survives). Rules writes are binding guidance mounted into every session in the org — write conservatively, confirm with the user first, and expect the permission prompt. Writes need an API key with the `read+write` scope (a lesser key gets a clear `write_scope_required` error, not a silent no-op); in a multi-repo corpus every save needs `repo_id`.
- **Size the risk with the graph.** For diffs touching shared symbols or public contracts, run `impact-analysis` (callers, blast radius, tests) and let the radius set the review bar: a 3-caller internal helper and a 300-dependent contract do not deserve the same scrutiny.
- **Cite what you flag.** Every rule- or knowledge-based comment should name the rule or memory it comes from (`citing-bonez-sources`) so the author can read the source, not argue with you.

## When to stop

Rules applied, weirdness checked against what the graph knows, blast radius sized for risky hunks. Don't turn every review into an archaeology dig — prior-art depth belongs on the risky parts of the diff, not every line.
