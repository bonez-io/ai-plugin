#!/usr/bin/env bash
# PreToolUse gate for the bonez MCP write tools: `memory` and `rules`.
#
# Both tools take an `op` that selects the action: reads (`recall` for
# memory; `list` / `get` for rules) or `save` / `update` / `delete` (writes —
# to the org's durable memory, or to its standing rules and slash commands,
# which are binding guidance mounted into every session). Once the user
# allow-lists a tool, every write would run without a prompt. This hook
# re-introduces a prompt for the write ops by returning
# `permissionDecision: "ask"`; reads and anything it cannot parse fall
# through to normal permission flow.
#
# Env knobs:
#
#   BONEZ_MCP_GATE_DISABLE — set to a non-empty value other than `0` to turn
#       the gate off entirely. For remote devboxes and headless/CI runs where
#       nobody can answer the prompt:
#
#           export BONEZ_MCP_GATE_DISABLE=1
#
# Pure bash; no jq or other third-party tools required. `op` values are short
# lowercase identifiers, so a narrow regex on the raw JSON payload is safe to
# match against: any `"op":` text inside *string* params arrives JSON-escaped
# as \"op\" and cannot match a regex written against real quote characters.
# But object-valued params (the rules tool's `params_schema`) DO arrive with
# real-quoted keys, and key order is model-controlled — so extraction must
# never trust "the first `"op"` match". A write op ANYWHERE in the payload
# prompts (see the extraction comment below).

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
protocol=""
if [[ "$input" =~ \"hook_event_name\"[[:space:]]*:[[:space:]]*\"beforeMCPExecution\" ]]; then
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

# Only gate the bonez memory/rules tools.
#
# Claude Code flattens the server into the tool name — `mcp__bonez__memory`
# (raw `claude mcp add`), `mcp__plugin_bonez_bonez__memory` (plugin-installed),
# or a renamed server key that still contains `bonez`. hooks.json matches
# broadly on `__(memory|rules)$`; this is the narrow check, so a different
# product's memory or rules tool never gets our prompt.
#
# Cursor keeps them apart: `tool_name` is the BARE tool (`memory`), and the
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
    elif [[ "$tool_name" =~ ^mcp__[A-Za-z0-9_-]*bonez[A-Za-z0-9_-]*__(memory|rules)$ ]]; then
        # A build that flattens the server into the tool name the way Claude Code
        # does identifies itself that way and needs no separate server field.
        identified=1
    fi
    (( identified )) || exit 0
    [[ "$tool_name" =~ ^(mcp__[A-Za-z0-9_-]*bonez[A-Za-z0-9_-]*__)?(memory|rules)$ ]] || exit 0
    tool="${BASH_REMATCH[2]}"
else
    [[ "$tool_name" =~ ^mcp__[A-Za-z0-9_-]*bonez[A-Za-z0-9_-]*__(memory|rules)$ ]] || exit 0
    tool="${BASH_REMATCH[1]}"
fi

# Extract `op` by looking for a real (unescaped-quote) `"op":"<write-op>"`
# ANYWHERE in the payload — one regex pass, no loop. The tool input's real op
# is not necessarily the first `"op"` key: object-valued params (the rules
# tool's `params_schema`) arrive with real-quoted keys, and JSON key order is
# model-controlled — so a crafted payload like
# `{"params_schema":{"op":"list"},"op":"save",…}` would shadow the write op
# if only the first `"op"` match were consulted. Matching write ops directly
# fails toward prompting: a read op whose nested params merely mention a
# write-op name may prompt unnecessarily; that is the safe direction for a
# write gate. Silence on a real write is the failure mode this hook exists
# to prevent.
#
# Cursor adds one wrinkle: it documents `tool_input` as a JSON *string*, so its
# params arrive escaped (`\"op\":\"save\"`) where Claude Code's arrive as a real
# object. On that leg ONE level of escaping is structural, so unescape `\"` to
# `"` before matching.
#
# This is deliberately NOT done for Claude Code. There, escaped quotes mean the
# opposite thing — they are string CONTENT (`{"op":"recall","query":"note that
# {\"op\":\"delete\"} appears in a doc"}`) — and unescaping would turn a quoted
# mention of a write op into a false prompt, which
# tests/test_gate.sh::"escaped op text inside content does not fool the gate"
# pins. The same protection survives on the Cursor leg for free: content text
# inside its stringified `tool_input` is DOUBLE-escaped, so one pass leaves it
# as `\"` and it still cannot match.
haystack="$input"
if [[ "$protocol" == "cursor" ]]; then
    haystack="${input//\\\"/\"}"
fi

op=""
if [[ "$haystack" =~ \"op\"[[:space:]]*:[[:space:]]*\"(save|update|delete)\" ]]; then
    op="${BASH_REMATCH[1]}"
fi

# Prompt only for the write ops. Payloads whose only ops are reads
# (`recall`, `list`, `get`), a missing op, or anything unrecognized leave
# `op` empty and fall through to normal permission flow. The case guard is
# belt-and-braces: `op` can already only be a write op or empty.
case "$op" in
    save|update|delete)
        # `tool` is restricted to memory|rules and `op` to
        # save|update|delete by the regexes above, so interpolating them
        # into the JSON response is safe. `target` is a fixed literal.
        target="durable org memory"
        if [[ "$tool" == "rules" ]]; then
            target="the org's binding rules and commands"
        fi
        reason="bonez $tool \`$op\` writes to $target — approve to run."
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
        ;;
esac

exit 0
