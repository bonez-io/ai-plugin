#!/usr/bin/env bash
# Cursor `sessionStart` hook — flushes the PREVIOUS conversation in this workspace.
#
# This is not belt-and-braces; on Cursor it is the path that actually works. Cursor 3.18.25
# tears down its shell-exec service before running sessionEnd hooks on `reason: window_close`,
# so every command hook in that batch dies with "MainThreadShellExec not initialized" — ours
# and unrelated third-party ones alike. Quitting the app therefore captures nothing, no matter
# how correct the hook is. Flushing from disk on the next start sidesteps the teardown
# entirely, and covers crashes and SIGKILL for free.
#
# It uploads at most ONE not-yet-synced conversation per start, never the session just
# beginning, and only from the current workspace's transcript directory.
#
# This wrapper exists for one reason: path resolution. Cursor documents how a PROJECT hook's
# relative command resolves (against the project root) and how a USER hook's does (against
# ~/.cursor/), but says nothing about a hook shipped inside a plugin. So the command in
# hooks.json stays the same shape the gate already relies on (`./hooks/<script>`), and the
# script itself — which always knows where it lives — resolves the interpreter and the .mjs
# absolutely from there. Whatever working directory Cursor picks, the node invocation is exact.
#
# Everything downstream is the SAME bin/bonez-session-sync.mjs the Claude Code and Codex legs
# use, so consent, credentials, scoping and debounce behave identically across all three
# clients. It is a silent no-op until `login` (or, headless, `install`) has been run — see the
# README's "Session capture" section.
#
# Env knobs:
#
#   BONEZ_SESSION_SYNC=0 — disable capture without uninstalling (honoured inside the .mjs).
#
# Exits 0 on every path. A sessionStart hook runs while the user is waiting to start work;
# a non-zero exit or any output here would be noise in front of someone who did not ask for
# it, and there is no failure worth interrupting them over.
trap 'exit 0' EXIT
set -u

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SYNC="$HERE/../bin/bonez-session-sync.mjs"

[ -f "$SYNC" ] || exit 0

# Cursor's GUI process does not inherit a login shell's PATH, so a node installed by nvm,
# Homebrew or mise may be invisible here even though it is on the user's PATH in a terminal.
# Probe the usual locations before giving up, and give up SILENTLY: a user without node is not
# doing anything wrong, and session capture is an opt-in extra, not a dependency of the plugin.
NODE_BIN="${BONEZ_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  for candidate in node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if command -v "$candidate" >/dev/null 2>&1; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
[ -n "$NODE_BIN" ] || exit 0

# stdin (the hook payload JSON) passes straight through. stdout is discarded rather than
# forwarded: the .mjs is written never to print, and this guarantees it even if that changes.
"$NODE_BIN" "$SYNC" hook cursor session-start >/dev/null 2>&1
exit 0
