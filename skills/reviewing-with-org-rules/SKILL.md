---
name: reviewing-with-org-rules
description: Review code against the org's standing rules. Use when reviewing a PR, diff, or change in a bonez-connected org, when asked whether code follows the org's conventions, or before approving, merging, or signing off on anything non-trivial.
---

# Reviewing with org rules

A review that applies only generic taste misses the point in an org with standing rules: the org has already decided how it wants its code to look, ship, and fail. Pull those decisions first; then review.

## Before reading the diff

Mount the rules and knowledge for the repo under review with `bonez:context`:

```json
{"scope": "<repo_id>", "include": ["rules", "knowledge"]}
```

- **rules** — the org's standing repo and review rules. These are your review checklist's spine.
- **knowledge** — gotchas and decisions for this repo: the difference between "weird code" and "deliberate code".

## Judgment

- **Org rules outrank your defaults.** Flag violations of THEIR rules before stylistic preferences. When a rule contradicts what you'd normally suggest, the rule wins — and cite it, so the author sees it's the org speaking, not you.
- **Run the deliberate-weirdness check.** Before flagging something odd, look for the decision that explains it — the knowledge band, or `bonez:search` on the touched area. If a decision explains it, don't flag it; cite the decision instead. Re-litigating settled decisions is review noise.
- **Search the touched area for known gotchas.** A past incident or documented trap in the exact file being changed is the single highest-value review comment you can make (`finding-prior-art` workflow, scoped to the diff's files).
- **No rules mounted ≠ no rules.** An unavailable marker on the rules band means the review ran without org rules — say so in the review summary rather than silently reviewing on taste alone.
- **Size the risk with the graph.** For diffs touching shared symbols or public contracts, run `impact-analysis` (callers, blast radius, tests-for) and let the radius set the review bar: a 3-caller internal helper and a 300-dependent contract do not deserve the same scrutiny.
- **Cite what you flag.** Every rule- or knowledge-based comment should carry its vendor URL (`citing-bonez-sources`) so the author can read the source, not argue with you.

## When to stop

Rules applied, weirdness checked against knowledge, blast radius sized for risky hunks. Don't turn every review into an archaeology dig — prior-art depth belongs on the risky parts of the diff, not every line.
