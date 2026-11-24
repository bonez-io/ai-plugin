---
description: Turn Bonez session capture on or off, check it, or add your recent sessions (backfill)
---

Session capture saves this machine's coding sessions to the team's Bonez when they end, so Bonez learns from them. Secrets are removed on this machine before anything is sent. The user typed one of `on`, `off`, `status` or `backfill` after the command; nothing means `status`.

**Find the script once.** It is `bin/bonez-session-sync.mjs` inside the installed Bonez plugin under `~/.cursor/plugins/` (`%USERPROFILE%\.cursor\plugins\` on Windows). If there are several copies, use the most recently modified one. Run it with `node "<absolute path>" <subcommand>` in the terminal. If none is found, tell the user to reinstall the Bonez plugin and stop.

Show the user the script's output in full. Do not shorten links.

## on

Run `node "<path>" on`. It prints a link and returns at once. Tell the user to open the link and approve. Capture turns on by itself when they approve; nothing else is needed. If it prints `already on`, say so and run `status`.

## off

Run `node "<path>" decline`. Capture stops, and Bonez will not ask again. They can turn it back on with `/bonez-capture on`.

## status

Run `node "<path>" status`. Point out the two lines that matter: `last upload attempt` and `last successful upload`.

## backfill

This sends sessions from before capture was on. Do it in two steps, and never skip the first:

1. Run `node "<path>" backfill --dry-run --limit=20` and show how many sessions it would send.
2. Ask the user to confirm. Only after a clear yes, run `node "<path>" backfill --limit=20`. Run it again to send the next 20; each run sends the newest sessions not sent yet.

If capture is not on yet, say so and offer `/bonez-capture on` first.
