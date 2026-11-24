---
name: capture
description: Turn Bonez session capture on or off, check it, or add your recent sessions (backfill)
argument-hint: on | off | status | backfill
---

# /bonez:capture

Session capture saves this machine's coding sessions to the team's Bonez when they end, so Bonez learns from them. Secrets are removed on this machine before anything is sent. The user asked for: **$ARGUMENTS** (no argument means `status`).

Run the plugin's own script with the Bash tool. It is on the Bash tool's `PATH` while this plugin is enabled, so the bare name works: `bonez-session-sync.mjs <subcommand>`. If the shell cannot find it, use `node "${CLAUDE_PLUGIN_ROOT}/bin/bonez-session-sync.mjs" <subcommand>`.

Show the user the script's output in full. Do not shorten links.

## on

Run `bonez-session-sync.mjs on`. It prints a link and returns at once. Tell the user to open the link and approve. Capture turns on by itself when they approve; nothing else is needed. If it prints `already on`, say so and run `status`.

## off

Run `bonez-session-sync.mjs decline`. Capture stops, and Bonez will not ask again. They can turn it back on with `/bonez:capture on`.

## status

Run `bonez-session-sync.mjs status`. Point out the two lines that matter: `last upload attempt` and `last successful upload`.

## backfill

This sends sessions from before capture was on. Do it in two steps, and never skip the first:

1. Run `bonez-session-sync.mjs backfill --dry-run --limit=20` and show how many sessions it would send.
2. Ask the user to confirm. Only after a clear yes, run `bonez-session-sync.mjs backfill --limit=20`. Run it again to send the next 20; each run sends the newest sessions not sent yet.

If capture is not on yet, say so and offer `/bonez:capture on` first.
