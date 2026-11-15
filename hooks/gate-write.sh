#!/usr/bin/env bash
# PreToolUse gate for the bonez MCP write tools.
#
#   memory_save  durable memory in the org's System Model.
#   rules_write  save / update / delete of the org's standing rules and slash
#                commands, which are binding guidance mounted into every session.
#
# Both are write tools whatever the input, so every call prompts: the hook
# returns `permissionDecision: "ask"`. Once the user allow-lists a tool, this is
# what brings the prompt back. `rules_read` and the other tools are not matched
# and fall through to normal permission flow, as does anything it cannot parse.
#
# Env knobs:
#
#   BONEZ_MCP_GATE_DISABLE — set to a non-empty value other than `0` to turn
#       the gate off entirely. For remote devboxes and headless/CI runs where
#       nobody can answer the prompt:
#
#           export BONEZ_MCP_GATE_DISABLE=1
#
# Pure bash; no jq or other third-party tools required.

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

# Harness detection. This hook speaks TWO protocols:
#
#   Claude Code  PreToolUse          -> {"hookSpecificOutput":{...,"permissionDecision":"ask"}}
#   Cursor       beforeMCPExecution  -> {"permission":"ask",...}
#
# Codex is deliberately excluded: it sets its native PLUGIN_ROOT and rejects an
# "ask" decision while already gating tools through its own approval flow, so
# exiting early there means the hook neither errors nor fights the host prompt.
# (Cursor sets CLAUDE_PROJECT_DIR as an alias for its project dir but never
# CLAUDE_PLUGIN_ROOT, so the Claude branch below cannot be entered by mistake.)
if [[ -n "${PLUGIN_ROOT:-}" ]]; then
    exit 0
fi

# Full opt-out. Set to any non-empty value other than `0`.
if [[ -n "${BONEZ_MCP_GATE_DISABLE:-}" && "${BONEZ_MCP_GATE_DISABLE}" != "0" ]]; then
    exit 0
fi

input="$(cat)"

# Which protocol is this? The payload's own `hook_event_name` decides, not the
# environment: it is the one field both hosts always send, and keying on it
# means a host that sets a surprising env var cannot route us into the wrong
# response shape. Anything we do not recognise falls through silently.
#
# The tool's own input is model-controlled and can carry either event name as a
# nested key. So Claude Code is recognised first, by its event name together
# with the env var only it sets: a `beforeMCPExecution` buried in a tool input
# cannot turn a Claude Code call into a Cursor-shaped answer that Claude Code
# would ignore. On Cursor the env var is absent, so a nested `PreToolUse`
# cannot do the reverse.
protocol=""
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && "$input" =~ \"hook_event_name\"[[:space:]]*:[[:space:]]*\"PreToolUse\" ]]; then
    protocol="claude"
elif [[ "$input" =~ \"hook_event_name\"[[:space:]]*:[[:space:]]*\"beforeMCPExecution\" ]]; then
    protocol="cursor"
elif [[ "$input" =~ \"hook_event_name\"[[:space:]]*:[[:space:]]*\"PreToolUse\" ]]; then
    protocol="claude"
elif [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
    # Older Claude Code builds that omit `hook_event_name` on input. The env var
    # is Claude-Code-only (see the detection note above), so this stays narrow.
    protocol="claude"
fi
[[ -n "$protocol" ]] || exit 0

# The Claude leg additionally requires CLAUDE_PLUGIN_ROOT, unchanged: that is
# how it has always distinguished "running as an installed plugin" from a bare
# invocation, and tests/test_gate.sh pins it.
if [[ "$protocol" == "claude" && -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
    exit 0
fi

# Extract `tool_name` — simple identifier, no escaping inside the value.
tool_name=""
if [[ "$input" =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    tool_name="${BASH_REMATCH[1]}"
fi

# Only gate the two bonez write tools.
#
# Claude Code flattens the server into the tool name — `mcp__bonez__memory_save`
# (raw `claude mcp add`), `mcp__plugin_bonez_bonez__memory_save` (plugin-installed),
# or a renamed server key that still contains `bonez`. hooks.json matches
# broadly on `__(memory_save|rules_write)$`; this is the narrow check, so a
# different product's tool of the same name never gets our prompt.
#
# Cursor keeps them apart: `tool_name` is the BARE tool (`memory_save`), and the
# server key arrives separately as `mcp_server_name`. So the server identity
# has to be checked there instead — and Cursor's hooks.json carries no matcher
# at all, making this the ONLY filter on that leg.
tool=""
if [[ "$protocol" == "cursor" ]]; then
    # Which field identifies the server is NOT settled across Cursor's own
    # sources: cursor.com/docs/agent/hooks documents `mcp_server_name`, while the
    # published `cursor-hooks` types (BeforeMCPExecutionPayload) carry only
    # tool_name/tool_input/url?/command?. Requiring `mcp_server_name` would mean
    # the gate SILENTLY NEVER FIRES on any build that omits it — the worst
    # failure available to a write gate. So accept identification from whichever
    # of the three is present, and only give up when none of them names bonez.
    identified=0
    if [[ "$input" =~ \"mcp_server_name\"[[:space:]]*:[[:space:]]*\"([^\"]*bonez[^\"]*)\" ]]; then
        identified=1
    elif [[ "$input" =~ \"url\"[[:space:]]*:[[:space:]]*\"([^\"]*bonez[^\"]*)\" ]]; then
        identified=1
    elif [[ "$tool_name" =~ ^mcp__[A-Za-z0-9_-]*bonez[A-Za-z0-9_-]*__(memory_save|rules_write)$ ]]; then
        # A build that flattens the server into the tool name the way Claude Code
        # does identifies itself that way and needs no separate server field.
        identified=1
    fi
    (( identified )) || exit 0
    [[ "$tool_name" =~ ^(mcp__[A-Za-z0-9_-]*bonez[A-Za-z0-9_-]*__)?(memory_save|rules_write)$ ]] || exit 0
    tool="${BASH_REMATCH[2]}"
else
    [[ "$tool_name" =~ ^mcp__[A-Za-z0-9_-]*bonez[A-Za-z0-9_-]*__(memory_save|rules_write)$ ]] || exit 0
    tool="${BASH_REMATCH[1]}"
fi

# `tool` is one of the two names above, so interpolating it into the JSON
# response is safe.
if [[ "$tool" == "rules_write" ]]; then
    target="the org's binding rules and commands"
else
    target="durable memory in the org's System Model"
fi
reason="bonez $tool writes to $target — approve to run."
if [[ "$protocol" == "cursor" ]]; then
    # Cursor's beforeMCPExecution contract: a flat object with
    # `permission`, plus the two message fields it renders. "ask" is
    # genuinely supported here — unlike Codex, whose PreToolUse parses
    # "ask" but leaves it unimplemented (see README).
    # camelCase is what the published `cursor-hooks` types declare
    # (HookPermissionResponse: permission/userMessage/agentMessage); the
    # docs page prints snake_case for the same fields. Both spellings are
    # emitted because an unknown key is ignored either way, whereas
    # guessing wrong silently drops the explanation shown to the human.
    # `permission` — the field that actually gates the call — is agreed.
    printf '{"permission":"ask","userMessage":"%s","agentMessage":"%s","user_message":"%s","agent_message":"%s"}' \
        "$reason" "$reason" "$reason" "$reason"
else
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}' "$reason"
fi

exit 0
