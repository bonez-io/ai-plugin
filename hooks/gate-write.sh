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

# Only gate the bonez memory/rules tools. Covers every namespacing Claude
# Code uses: `mcp__bonez__memory` (raw `claude mcp add`),
# `mcp__plugin_bonez_bonez__memory` (plugin-installed), and renamed server
# keys that still contain `bonez`. hooks.json matches broadly on
# `__(memory|rules)$`; this is the narrow check, so a different product's
# memory or rules tool never gets our prompt.
[[ "$tool_name" =~ ^mcp__[A-Za-z0-9_-]*bonez[A-Za-z0-9_-]*__(memory|rules)$ ]] || exit 0
tool="${BASH_REMATCH[1]}"

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
op=""
if [[ "$input" =~ \"op\"[[:space:]]*:[[:space:]]*\"(save|update|delete)\" ]]; then
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
        printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"bonez %s `%s` writes to %s — approve to run."}}' "$tool" "$op" "$target"
        ;;
esac

exit 0
