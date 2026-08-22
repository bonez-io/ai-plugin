#!/usr/bin/env bash
# PreToolUse gate for the bonez MCP `memory` tool.
#
# The bonez MCP exposes one `memory` tool whose `op` selects the action:
# `recall` (read-only) or `save` / `update` / `delete` (writes to the org's
# durable memory). Once the user allow-lists the memory tool, every write
# would run without a prompt. This hook re-introduces a prompt for the write
# ops by returning `permissionDecision: "ask"`; `recall` and anything it
# cannot parse fall through to normal permission flow.
#
# Env knobs:
#
#   BONEZ_MCP_GATE_DISABLE — set to a non-empty value other than `0` to turn
#       the gate off entirely. For remote devboxes and headless/CI runs where
#       nobody can answer the prompt:
#
#           export BONEZ_MCP_GATE_DISABLE=1
#
# Pure bash; no jq or other third-party tools required. The `op` value is a
# short lowercase identifier, so a narrow regex on the raw JSON payload is
# safe (any `"op":` text inside user content arrives JSON-escaped as \"op\"
# and cannot match a regex written against real quote characters).

# Fail open — this gate must never break a tool call.
#
# The "ask" decision is delivered entirely through the stdout JSON below; the
# exit code never signals it. Every exit path is forced to 0 via an EXIT trap,
# so an unexpected runtime failure falls through to normal permission flow
# instead of surfacing as a hook error. Crucially, the hook can never exit 2,
# which Claude Code interprets as a hard *block* of the tool call.
#
# The one failure a trap can't catch is a parse-time syntax error (the trap
# isn't installed yet); `tests/test_gate.sh` guards that with `bash -n`.
trap 'exit 0' EXIT

set -u

# Harness detection: this hook speaks Claude Code's PreToolUse JSON protocol.
# Claude Code sets CLAUDE_PLUGIN_ROOT (and never PLUGIN_ROOT); Codex sets its
# native PLUGIN_ROOT and rejects `permissionDecision: "ask"` while already
# gating tools through its own approval flow. Exit early anywhere that isn't
# Claude Code so the hook neither errors nor fights the host's prompt.
if [[ -n "${PLUGIN_ROOT:-}" ]]; then
    exit 0
fi
if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
    exit 0
fi

# Full opt-out. Set to any non-empty value other than `0`.
if [[ -n "${BONEZ_MCP_GATE_DISABLE:-}" && "${BONEZ_MCP_GATE_DISABLE}" != "0" ]]; then
    exit 0
fi

input="$(cat)"

# Extract `tool_name` — simple identifier, no escaping inside the value.
tool_name=""
if [[ "$input" =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    tool_name="${BASH_REMATCH[1]}"
fi

# Only gate the bonez memory tool. Covers every namespacing Claude Code uses:
# `mcp__bonez__memory` (raw `claude mcp add`), `mcp__plugin_bonez_bonez__memory`
# (plugin-installed), and renamed server keys that still contain `bonez`.
# hooks.json matches broadly on `__memory$`; this is the narrow check, so a
# different product's memory tool never gets our prompt.
[[ "$tool_name" =~ ^mcp__[A-Za-z0-9_-]*bonez[A-Za-z0-9_-]*__memory$ ]] || exit 0

# Extract `op`. The first real (unescaped-quote) "op" key in the payload is
# the tool input's op — hook envelope fields (session_id, cwd, tool_name, …)
# never use that name.
op=""
if [[ "$input" =~ \"op\"[[:space:]]*:[[:space:]]*\"([a-zA-Z_-]+)\" ]]; then
    op="${BASH_REMATCH[1]}"
fi

# Prompt only for the write ops. `recall`, a missing op, or anything
# unrecognized falls through to normal permission flow.
case "$op" in
    save|update|delete)
        # `op` is restricted to [a-zA-Z_-]+ by the regex above, so
        # interpolating it into the JSON response is safe.
        printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"bonez memory `%s` writes to durable org memory — approve to run."}}' "$op"
        ;;
esac

exit 0
