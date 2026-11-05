---
name: context
description: Orient in your Bonez graph — what it holds, the standing rules in effect, and (optionally) what it knows about a repo or topic
argument-hint: [repo_id or topic]
---

# /bonez:context

Load the standing rules with `rules(op="list")` and the current work with `memory_recall({})`. Use the supplied repo to scope rules, or the supplied topic to search the graph. Open the matching WorkItem with `graph_fetch` and follow the linked session or tracker record that explains the latest decision. Use `graph_schema` when the shape is unfamiliar.

Tell the user where their work stands, what evidence supports it and what remains open. Cite the sources you used. If the server lacks recall, use search and fetch for attached memories. Report any material gap in access or coverage.
