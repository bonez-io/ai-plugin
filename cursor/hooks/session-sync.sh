#!/usr/bin/env bash
# Cursor session-capture hook — hands the conversation transcript to bonez-session-sync.mjs.
#
# One script for every lifecycle event; hooks.json passes which one as $1. There were three
# near-identical copies of this before, plus a CI check to stop them drifting — all of that
# was machinery guarding a difference of one word.
#
#   sessionEnd   -> session-end    the conversation ended — upload it. Works when a chat tab
#                                  or the window is closed normally, but NOT when you quit the
#                                  app: on `reason: window_close` Cursor tears down its
#                                  shell-exec service before running sessionEnd hooks, so every
#                                  command hook in that batch dies with "MainThreadShellExec
#                                  not initialized" (verified, Cursor 3.18.25). Nothing
#                                  plugin-side can fix that, hence the next line.
#   sessionStart -> session-start  on opening a chat, upload anything in this workspace that
#                                  never made it — the quit case above, plus crashes and
#                                  kills. This is the safety net that makes the gap harmless.
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
# Exits 0 with no output on every path — a hook that prints or fails is a hook the user
# notices, and there is nothing here worth interrupting them for.
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
