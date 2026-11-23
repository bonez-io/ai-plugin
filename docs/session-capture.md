# Bonez session capture: set up and test

Session capture saves your coding sessions to your team's Bonez when they end, so Bonez learns from
what you tried, what broke and what you decided. It works in Claude Code (terminal and the Code tab of
Claude Desktop), Codex (CLI and app) and Cursor.

- **What is sent:** your messages, the agent's replies, and its tool calls and results.
- **What is removed first, on your machine:** API keys, tokens, private keys, passwords and
  connection strings.
- **Who can read it:** people in your Bonez organization.
- **What is never sent:** files the session did not show the agent, and anything from a Bonez server
  that is not Bonez's own (`gateway.bonez.io`).

You need the Bonez plugin installed and signed in first: <https://gateway.bonez.io/mcp/install>.

## 1. Turn it on

### The easiest way: the setup page

The first time you start a session on a machine where capture was never set up, Bonez opens a setup
page in your browser and shows one line:

> Bonez opened a setup page in your browser to finish connecting. If it did not open: <link>

On the page, sign in, check which of your tools are connected, and choose whether to save your sessions
and whether to add the sessions from the last 14 days. Your computer picks up the answer by itself: with
"Turn on", capture is on for every repo and the recent sessions are sent in the background. The page
opens only once per machine. If you close it, the later starts offer the link described below instead.

You can also run the setup page from a terminal, and watch it finish:

```
node <plugin folder>/bin/bonez-session-sync.mjs connect
```

It prints the page's link, waits while you answer, then says "Session saving is on." and, if you chose
it, "Adding 37 recent sessions… 37/37". Add `--no-open` to only print the link. The link works for 30
minutes. The install script runs this at its end.

### Or say yes to the offer

On later session starts, while capture is still off, Bonez shows one line:

> Bonez can save your coding sessions to your team's Bonez, so it learns from them … Turn it on with one
> click: https://auth.bonez.io/activate?user_code=… — Not now: ignore this. Never: /bonez:capture off

Open the link, check the code matches, and approve. That is all. The next session starts with
"Bonez session capture is on".

Where the line appears:

| Tool | Where you see it |
| --- | --- |
| Claude Code (terminal) | Above the prompt when the session starts. |
| Claude Desktop, Code tab | At the top of a new session. |
| Codex CLI and app | As a warning when the session starts. Codex runs a plugin's hooks only after you trust them: run `/hooks` in the CLI, or **Review hooks** in the app, and approve the Bonez hooks. |
| Cursor | The agent repeats it at the start of its first reply. |

If you ignore it, Bonez asks again on another day (three times), then once a week.

### Or turn it on yourself

| Tool | Do this |
| --- | --- |
| Claude Code, Claude Desktop Code tab | Type `/bonez:capture on` |
| Cursor | Type `/bonez-capture on` |
| Codex, or any terminal | Run `node <plugin folder>/bin/bonez-session-sync.mjs on` |

Each prints the approval link. Approve it in the browser, and capture is on.

To find the plugin folder for Codex: `ls ~/.codex/plugins/cache/*/bonez/*/bin/bonez-session-sync.mjs`.
In Claude Code the script is on the agent's shell path, so `bonez-session-sync.mjs on` works in the
Bash tool. On Windows, run it with `node "<full path>" on` in PowerShell.

### Claude Desktop chat and Cowork

Capture needs a program on your machine at the end of a session, and Claude's chat and Cowork do not
run plugin programs. Only the **Code** tab is captured.

## 2. Test it

### Step 1: is it on?

`/bonez:capture status` (Cursor: `/bonez-capture status`, terminal: `bonez-session-sync.mjs status`).
You should see:

```
bonez session capture: enabled
  sign-in:  OAuth — token valid …
  scope:    global
```

If it says `not installed`, go back to step 1.

### Step 2: live capture

1. Start a new session and send one short message, for example "say hi".
2. End the session: `/exit` in Claude Code or Codex, close the chat tab in Cursor.
3. Wait half a minute, then run `status` again. `last successful upload` should show the time you just
   ended the session.

In Cursor, a chat is also sent after the agent's turns (at most every two minutes), so you do not have
to close it. A session that ended without its hook running (a crash, quitting the app) is sent the next
time you start a session in the same folder.

### Step 3: backfill your recent sessions

Sessions from before capture was on are not sent unless you ask. Look first, then send:

1. `/bonez:capture backfill` in Claude Code or Cursor. The agent first runs a dry run and shows what it
   would send, then asks you to confirm.

   In a terminal, do the same by hand:

   ```bash
   bonez-session-sync.mjs backfill --dry-run --limit=20   # shows the 20 newest, sends nothing
   bonez-session-sync.mjs backfill --limit=20             # sends them
   ```

2. Run it again to send the next 20. Each run sends the newest sessions not sent yet, from Claude Code,
   Codex and Cursor together. Add `--agent=claude`, `--agent=codex` or `--agent=cursor` for one tool
   only.
3. Run `status`: `sessions synced` goes up by the number sent.

## 3. Turn it off

- `/bonez:capture off` (Cursor: `/bonez-capture off`, terminal: `bonez-session-sync.mjs decline`):
  off, and Bonez stops asking.
- `BONEZ_SESSION_SYNC=0` in your environment: off for that shell, settings kept.
- `BONEZ_CAPTURE_OFFER=0`: never open the setup page or show the offer (for CI and shared machines).
- `BONEZ_CONNECT_NO_OPEN=1`: `connect` prints the setup link instead of opening the browser.

## 4. If something is wrong

| You see | Do this |
| --- | --- |
| No offer at all | Run `status`. If it says `disabled`, capture was turned off on purpose; run `on`. In Codex, trust the plugin's hooks (`/hooks`). |
| The link says it expired | Run `/bonez:capture on` for a new one. Links last 15 minutes. |
| `last upload attempt: … failed` | The line says which step failed and why. `sync.log`, in the folder `status` names, has the detail. |
| "Bonez session capture has not uploaded since …" | Same as above: run `status`. |
| `signed in to gateway.bonez.io, but the plugin's server address is …` | Your plugin points at another Bonez server. Capture works only with `gateway.bonez.io`. |
