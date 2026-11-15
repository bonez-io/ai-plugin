---
name: who-owns-what
description: Finds people (owners, experts, reviewers) through the System Model. Use when asked who owns, maintains, wrote, changed, decided or knows something ("who owns billing", "who last changed this", "who should review this", "who do I ask"), when you must pick a reviewer or assignee, or when routing work to a human.
---

# Who owns what

People are records in the System Model, with accounts from the vendors the org has connected (source control, tickets, chat). Ownership questions are System Model questions.

## Workflow

1. Learn how people are modelled in THIS System Model before searching for them:

```json
{"find": "person"}
```

`system_model_schema` answers with the matching record types, link types and stored queries. Try `author` or `reviewer` too. Do not assume record type or link type names.

2. Find the person or the artifact with `system_model_search`, naming the person record types you just saw (omit `types` if you have none):

```json
{"text": "payments service", "limit": 10, "description": "Finding the payments service and who is attached to it"}
```

3. Traverse with `system_model_query` from either end — from an artifact toward its authors, or from a person toward what they touch. Prefer a stored query the schema lookup surfaced (for example, `commit_authors_for_ticket` and `prs_addressing_ticket` take a ticket `key`); hand-write BGQ only when none fits, and see `querying-the-graph` for the rules.

4. `system_model_fetch` the person record before naming them — don't guess emails or handles.

`system_model_history` is NOT code authorship: it is the System Model's own change log (who wrote a memory, what moved in it). Use it to see who recorded a memory or when a record was last updated, not who owns a system.

## Judgment

- **Ownership is behavioral, not titular.** Who reviews, who merges, who gets asked beats last-commit-wins. A recent PR author may be a drive-by contributor; the person who reviewed the last ten PRs in that directory is the owner-shaped signal.
- **Exclude bots.** Bot accounts author enormous volumes of commits and comments. Never nominate a bot as an owner or expert; discount bot activity when weighing evidence.
- **Identity linking can be incomplete.** Two similar-looking people (a source-control login and a ticket-system account, say) may be one unlinked human. When evidence splits oddly across near-duplicate identities, say they may be unlinked rather than naming two experts.
- **People go stale faster than code.** People leave; teams reorganize. Check the recency of the evidence before assigning — prefer "most recent sustained activity" over "most total activity".
- **Small orgs, small System Models.** With few indexed people, the top result may be the only candidate, not the best one. Report the strength of the evidence, not just the name.
- **Empty is not "nobody".** An empty result means the traversal found nothing, not that nobody owns it.

## Hand-offs

- "Why was this decided" (rather than "who decided") → `finding-prior-art`.
- Presenting a person with their evidence → `citing-bonez-sources`.
