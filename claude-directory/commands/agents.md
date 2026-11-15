---
name: agents
description: List your Bonez agents and their latest runs, or show one agent's recent runs
argument-hint: [agent name]
---

# /bonez:agents

Show the org's Bonez agents. Argument (optional): **$ARGUMENTS**

1. Run `tool_search` with `{"vendor": "bonez"}`. If it returns nothing, say this Bonez server cannot list agents from here (it is older than the `bonez` vendor), point to the Bonez web app, and stop. Use only operation ids that search showed you.

2. No argument: call `vendor_operation` with the `bonez.agent.list.v2` id and `{"input": {"limit": 20}}`. Show a compact table: name, enabled, triggers (each one's `summary`), latest run status and when. If `next_cursor` is set, say there are more and offer the next page. `q`, `trigger` (an operation type such as `linear.issue.changed`), `status` and `include_retired` narrow the list.

3. With an argument: call `bonez.agent.read.v2` with `{"name": "$ARGUMENTS"}` and `bonez.run.list.v1` with `{"agent": "$ARGUMENTS", "limit": 5}`. Show the agent in two lines (what it is, how it is triggered) and its recent runs (status, started, finished, who triggered). If a deployment is not `ready`, add its `readiness` reasons. An unknown name is an error: say so and offer the list.

4. Offer the next step: `bonez.run.read.v1` for a run's `result` (the agent's own report), `outcome` and error, or `bonez.session.list.v1` for its sessions. These are read-only; never run anything else without asking.

5. To change, pause or retire an agent, or to make a new one (a person starts it, or a schedule or an event such as a Linear ticket or a GitHub PR does), see the `creating-an-agent` skill.
