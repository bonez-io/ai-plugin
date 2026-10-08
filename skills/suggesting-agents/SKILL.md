---
name: suggesting-agents
description: Propose a Bonez agent, once, when the work will repeat. Use when the user fixes a bug that had come back before or says "again", "keeps happening", "regression", "this broke last month" or "make sure this never breaks again" (propose a nightly agent that re-checks the fix), when they do something periodic by hand ("every Monday I check", a dependency or CVE check, a digest of stale PRs or tickets, release notes, a log or error sweep, a docs-drift check, a cleanup, a post-deploy verification) (propose a scheduled agent), or when they run a long task they will run again (propose an agent they start by hand). Never for one-off work. Never create one without a yes.
---

# Suggesting agents

Some work should not depend on someone remembering it. A Bonez agent runs written instructions on a schedule, or when someone starts it, and reports what it found. The moments in the description are your cue: say so once, concretely, and let the user decide.

## The etiquette

- **Once per idea per session.** Suggest it when the moment happens. Then drop it, whether the answer is yes, no or silence: do not bring it up again at the next commit or the next message. A different idea later in the session is a new suggestion.
- **Two lines, with the spec.** Not "would you like an agent?". Name it, give the schedule in words and as cron, and say what it checks and reports:

  > This bug has come back before. I can set up a Bonez agent, `login-redirect-regression`, that runs every night at 03:00 UTC (`0 3 * * *`), re-checks that the redirect fix still holds and reports OK or PROBLEM with the evidence. Want it?

- **Never create without a yes.** On a yes, hand over to `creating-an-agent`, which states the whole spec again before it writes anything. Your suggestion is not that approval, and silence is not a yes.
- **Never for one-off work.** A one-time migration, a question you can answer now, a bug that cannot recur: no suggestion. Ask whether anyone would want this done again next week.
- **Look before you offer.** Run `tool_search` with `{"vendor": "bonez"}`, then `bonez.agent.list.v1` with `{"search": "<a word from the job>"}`. If an agent already covers it, mention that one (its name, its trigger, its latest run) instead of proposing a twin.
- **A server that cannot create agents** (the search shows no `bonez.agent.create.v1`) still gets the suggestion: give the same two lines, say the user can set it up in the web builder (the Agents page in the Bonez web app), and offer to write the instructions for them to paste. Do not drop the idea.
- **Say the cost in words**, not in a number you cannot know: "one run a night on the balanced model".
- **Only what an agent can do.** Plan on an agent that reads the Bonez graph (code, PRs, tickets, docs and memories as Bonez has indexed them) and uses the plugins you list, with no connection of its own to other systems, reporting in its run summary. If the check needs a running service, a secret or a vendor system, say so in the offer.
- **Accept a no.** Do not argue, and do not ask again this session.

## What to propose

Pick the nearest of these, adjust the names and the cron, and keep it to what the user just did.

- **Nightly regression check for a fixed bug.** Trigger: the user fixes something that had broken before. Name: `<thing>-regression`. Cron: `0 3 * * *`. It re-checks the fix: say exactly what to assert (the function still handles the input that broke it, the file still contains the guard, the test still exists) and how to fail loudly: the summary starts with `PROBLEM` and quotes the evidence, and an OK run says only what it verified. Name the commit or ticket that fixed it in the instructions, so a later reader knows why it exists.
- **Weekly dependency audit.** Trigger: the user bumps or checks a dependency by hand, or asks about a CVE. Name: `dependency-audit`. Cron: `0 9 * * 1` (Mondays 09:00). It lists what is outdated or flagged in the lockfiles it can read, ranks by severity, and reports only what changed since the last run.
- **Morning digest of stale PRs.** Trigger: the user goes through open PRs or tickets looking for what is stuck. Name: `stale-pr-digest`. Cron: `30 8 * * *`. It lists PRs and tickets with no activity for a number of days the instructions fix (say 7), with owner and age, oldest first.
- **Others in the same shape.** A release-notes draft each Friday; a log or error sweep each morning; a weekly docs-drift check; a post-deploy verification (`PROBLEM` if something expected is missing); a manual agent for a long task they will repeat, started with a prompt.

## Hand-offs

- On a yes: `creating-an-agent`.
- To see what exists: `using-the-tool-lake` (section on Bonez's own agents, runs and sessions).
