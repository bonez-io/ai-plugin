#!/usr/bin/env bash
# Tests for hooks/gate-write.sh.
#
# Plain bash, no dependencies. Run from anywhere:
#
#     ./tests/test_gate.sh
#
# Each case feeds a JSON payload (the same shape Claude Code passes on stdin)
# to the hook with a controlled environment, then asserts on stdout and exit
# status. "silent" = empty stdout + exit 0 (normal permission flow);
# "prompt"  = JSON `permissionDecision: ask` payload + exit 0.
#
# The gate exits early unless CLAUDE_PLUGIN_ROOT is set (that is how it
# detects it is running under Claude Code), so every case that should reach
# the gate logic sets it explicitly.

set -u

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../hooks/gate-write.sh"
PLUGIN_DIR="$(cd -- "$HERE/.." && pwd)"

pass=0
fail=0

# Run hook with given input + env and capture stdout. Args:
#   $1: case name
#   $2: stdin payload
#   $3: expected mode — "silent" or "prompt"
#   $4: when "prompt", the op expected in the response — "save" (memory,
#       the default tool) or "rules:save" to expect the rules wording
#   $5+: optional `KEY=VALUE` env overrides for this run (use these to unset
#        CLAUDE_PLUGIN_ROOT by not passing it — the base env is empty)
run_case() {
    local name="$1" payload="$2" expected="$3" expected_op="${4:-}"
    if (( $# >= 4 )); then shift 4; else shift $#; fi
    local out status
    out="$(env -i PATH="$PATH" CLAUDE_PLUGIN_ROOT="$PLUGIN_DIR" "$@" bash "$HOOK" <<<"$payload")"
    status=$?

    local ok=1
    if [[ "$expected" == "silent" ]]; then
        [[ -z "$out" && $status -eq 0 ]] || ok=0
    else
        # Match the actual JSON shape the hook produces, with the tool and
        # op interpolated. Any drift in the response template fails here.
        local tool_word="memory" op_word="$expected_op"
        if [[ "$expected_op" == *:* ]]; then
            tool_word="${expected_op%%:*}"
            op_word="${expected_op##*:}"
        fi
        local needle="\"permissionDecision\":\"ask\""
        local op_needle="bonez ${tool_word} \`${op_word}\` writes"
        [[ $status -eq 0 && "$out" == *"$needle"* && "$out" == *"$op_needle"* ]] || ok=0
    fi

    if (( ok )); then
        pass=$((pass + 1))
        printf "  ok   %s\n" "$name"
    else
        fail=$((fail + 1))
        printf "  FAIL %s\n       expected=%s status=%d stdout=%q\n" \
            "$name" "$expected" "$status" "$out"
    fi
}

# Helper: payload for a memory tool invocation with a given op and tool name.
memory_call() {
    local op="$1" tool_name="${2:-mcp__bonez__memory}"
    printf '{"tool_name":"%s","tool_input":{"op":"%s","content":"the deploy script lives in infra/"}}' "$tool_name" "$op"
}

# Helper: payload for a rules tool invocation with a given op and tool name.
rules_call() {
    local op="$1" tool_name="${2:-mcp__bonez__rules}"
    printf '{"tool_name":"%s","tool_input":{"op":"%s","name":"no-force-push","content":"Never force-push shared branches."}}' "$tool_name" "$op"
}

echo "Running gate-write.sh tests..."

# --- syntax check first: a parse-time error is the one failure the hook's ---
# --- EXIT trap cannot catch (the trap is not installed yet).              ---

if bash -n "$HOOK" 2>/dev/null; then
    pass=$((pass + 1)); printf "  ok   hook passes 'bash -n' syntax check\n"
else
    fail=$((fail + 1)); printf "  FAIL hook has a syntax error ('bash -n')\n"
fi

# --- pass-through cases ---

run_case "non-memory tool is ignored" \
    '{"tool_name":"Bash","tool_input":{"command":"echo save"}}' \
    silent

run_case "other product memory tool is ignored" \
    "$(memory_call save mcp__someothermcp__memory)" \
    silent

run_case "read op (recall) is silent" \
    "$(memory_call recall)" \
    silent

run_case "missing op is silent" \
    '{"tool_name":"mcp__bonez__memory","tool_input":{"query":"deploy conventions"}}' \
    silent

run_case "unknown op is silent" \
    "$(memory_call frobnicate)" \
    silent

# --- write ops prompt ---

run_case "save prompts" \
    "$(memory_call save)" \
    prompt save

run_case "update prompts" \
    "$(memory_call update)" \
    prompt update

run_case "delete prompts" \
    "$(memory_call delete)" \
    prompt delete

run_case "save via plugin-prefixed tool name prompts" \
    "$(memory_call save mcp__plugin_bonez_bonez__memory)" \
    prompt save

run_case "escaped op text inside content does not fool the gate" \
    '{"tool_name":"mcp__bonez__memory","tool_input":{"op":"recall","query":"note that {\"op\":\"delete\"} appears in a doc"}}' \
    silent

# --- rules tool: reads pass through, writes prompt ---

run_case "other product rules tool is ignored" \
    "$(rules_call save mcp__someothermcp__rules)" \
    silent

run_case "rules read op (list) is silent" \
    "$(rules_call list)" \
    silent

run_case "rules read op (get) is silent" \
    "$(rules_call get)" \
    silent

run_case "rules save prompts" \
    "$(rules_call save)" \
    prompt rules:save

run_case "rules update prompts" \
    "$(rules_call update)" \
    prompt rules:update

run_case "rules delete prompts" \
    "$(rules_call delete)" \
    prompt rules:delete

run_case "rules save via plugin-prefixed tool name prompts" \
    "$(rules_call save mcp__plugin_bonez_bonez__rules)" \
    prompt rules:save

# --- object-valued params must not shadow the write op ---
#
# `params_schema` is a nested JSON object, so its keys arrive with REAL
# quotes (unlike string content, which arrives escaped). JSON key order is
# model-controlled, so an "op" key inside the object placed before the real
# op would defeat a first-match extraction. The gate must scan all matches.

run_case "rules save with a leading params_schema op:list still prompts" \
    '{"tool_name":"mcp__bonez__rules","tool_input":{"params_schema":{"op":"list"},"op":"save","name":"x","content":"y"}}' \
    prompt rules:save

run_case "rules save with a trailing params_schema op:get still prompts" \
    '{"tool_name":"mcp__bonez__rules","tool_input":{"op":"save","name":"x","content":"y","params_schema":{"op":"get"}}}' \
    prompt rules:save

# Fail-toward-prompting: a read op whose nested object mentions a write-op
# name prompts anyway. A spurious prompt is the safe direction for a write
# gate; silence on a real write is the failure mode this exists to prevent.
run_case "rules read with a nested write-op name fails toward prompting" \
    '{"tool_name":"mcp__bonez__rules","tool_input":{"op":"list","params_schema":{"op":"delete"}}}' \
    prompt rules:delete

# --- BONEZ_MCP_GATE_DISABLE turns the gate off entirely ---

run_case "disable=1 silences a save" \
    "$(memory_call save)" \
    silent "" \
    BONEZ_MCP_GATE_DISABLE="1"

run_case "disable=0 leaves the gate active" \
    "$(memory_call save)" \
    prompt save \
    BONEZ_MCP_GATE_DISABLE="0"

run_case "disable=1 silences a rules save too" \
    "$(rules_call save)" \
    silent "" \
    BONEZ_MCP_GATE_DISABLE="1"

# --- harness detection: only Claude Code gets the prompt ---

# Codex sets its native PLUGIN_ROOT; the gate must stand down there.
run_case "PLUGIN_ROOT set (Codex) silences a save" \
    "$(memory_call save)" \
    silent "" \
    PLUGIN_ROOT="/tmp/codex-plugin-root"

# No CLAUDE_PLUGIN_ROOT at all = not Claude Code; the gate must stand down.
out="$(env -i PATH="$PATH" bash "$HOOK" <<<"$(memory_call save)")"
status=$?
if [[ -z "$out" && $status -eq 0 ]]; then
    pass=$((pass + 1)); printf "  ok   no CLAUDE_PLUGIN_ROOT (non-Claude harness) is silent\n"
else
    fail=$((fail + 1)); printf "  FAIL no CLAUDE_PLUGIN_ROOT should be silent (status=%d stdout=%q)\n" "$status" "$out"
fi

# --- fail-open contract: the hook must never break a tool call ---
#
# The hook signals "ask" only via stdout JSON + exit 0. Every other path must
# also exit 0 so a hook failure can never reach Claude Code as exit 2 — which
# it treats as a hard *block* of the user's tool call.

for _payload in \
    '' \
    'not json at all {{{' \
    '{"tool_name":"mcp__bonez__memory"}' \
    '{"tool_name":"mcp__bonez__memory","tool_input":{"op":"sa' \
    "$(memory_call save)"
do
    env -i PATH="$PATH" CLAUDE_PLUGIN_ROOT="$PLUGIN_DIR" bash "$HOOK" <<<"$_payload" >/dev/null 2>&1
    if (( $? != 2 )); then
        pass=$((pass + 1)); printf "  ok   never exits 2 (block) for: %q\n" "$_payload"
    else
        fail=$((fail + 1)); printf "  FAIL exited 2 (would block) for: %q\n" "$_payload"
    fi
done

# --- summary ---

echo
echo "Passed: $pass  Failed: $fail"
(( fail == 0 ))
