#!/usr/bin/env bash
# Cursor session-capture hook — hands the conversation transcript to bonez-session-sync.mjs.
#
# One script for every lifecycle event; hooks.json passes which one as $1. There were three
# near-identical copies of this before, plus a CI check to stop them drifting — all of that
# was machinery guarding a difference of one word.
#
#   stop         -> turn-end       the PRIMARY trigger. Fires after every agent turn, while
#                                  the window is alive, independently per conversation, so
#                                  concurrent chats each capture themselves.
#   sessionEnd   -> session-end    captures the tail immediately when a chat tab is closed.
#                                  Does NOT run when you quit the app: on `window_close`
#                                  Cursor tears down shell-exec before running sessionEnd
#                                  hooks, so every command hook in the batch dies with
#                                  "MainThreadShellExec not initialized" (Cursor 3.18.25).
#                                  That is why `stop` carries the load, not this.
#   sessionStart -> session-start  flushes anything the two above missed — a crash, a kill,
#                                  or a final turn that landed inside the debounce window.
#
# The uploader debounces (BONEZ_SESSION_SYNC_DEBOUNCE_MS, default 120s) and skips unchanged
# transcripts, so a burst of quick turns collapses into one upload rather than one per turn.
#
# Path resolution is why this is a shell wrapper at all: Cursor documents how a PROJECT hook's
# relative command resolves and how a USER hook's does, but says nothing about a hook shipped
# inside a plugin. The script always knows where it lives, so it resolves the interpreter and
# the .mjs absolutely from there whatever working directory Cursor picks.
#
# Env knobs:
#
#   BONEZ_SESSION_SYNC=0 — disable capture without uninstalling (honoured inside the .mjs).
#   BONEZ_NODE           — path to node, if it is not on PATH (see the probe below).
#
# Exits 0 with no output on every path. That is correctness, not tidiness: a `stop` hook may
# return a followup_message which Cursor AUTO-SUBMITS as a new user turn, so anything printed
# here would be injected into the user's conversation.
trap 'exit 0' EXIT
set -u

EVENT="${1:-session-end}"

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

# stdin (the hook payload JSON) passes straight through.
"$NODE_BIN" "$SYNC" hook cursor "$EVENT" >/dev/null 2>&1
exit 0
