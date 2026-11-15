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
#   $4: when "prompt", the tool expected in the response (memory_save or rules_write)
#   $5+: optional `KEY=VALUE` env overrides for this run (use these to unset
#        CLAUDE_PLUGIN_ROOT by not passing it — the base env is empty)
run_case() {
    local name="$1" payload="$2" expected="$3" expected_tool="${4:-}"
    if (( $# >= 4 )); then shift 4; else shift $#; fi
    local out status
    out="$(env -i PATH="$PATH" CLAUDE_PLUGIN_ROOT="$PLUGIN_DIR" "$@" bash "$HOOK" <<<"$payload")"
    status=$?

    local ok=1
    if [[ "$expected" == "silent" ]]; then
        [[ -z "$out" && $status -eq 0 ]] || ok=0
    else
        # Match the actual JSON shape the hook produces, with the tool
        # interpolated. Any drift in the response template fails here.
        [[ $status -eq 0 && "$out" == *"\"permissionDecision\":\"ask\""* \
           && "$out" == *"bonez ${expected_tool} writes"* ]] || ok=0
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

# memory_save and rules_write prompt on any input; rules_read and the other
# reads pass.

for t in memory_save rules_write; do
    run_case "$t prompts" \
        "{\"tool_name\":\"mcp__plugin_bonez_bonez__$t\",\"tool_input\":{\"content\":\"deploys run from infra/\"}}" \
        prompt "$t"
    run_case "$t prompts even with a read-looking op" \
        "{\"tool_name\":\"mcp__plugin_bonez_bonez__$t\",\"tool_input\":{\"op\":\"list\"}}" \
        prompt "$t"
    run_case "$t via the raw-server prefix prompts" \
        "{\"tool_name\":\"mcp__bonez__$t\",\"tool_input\":{}}" \
        prompt "$t"
    run_case "$t via a renamed server key containing bonez prompts" \
        "{\"tool_name\":\"mcp__my-bonez-prod__$t\",\"tool_input\":{}}" \
        prompt "$t"
    run_case "$t from another product is ignored" \
        "{\"tool_name\":\"mcp__someothermcp__$t\",\"tool_input\":{}}" \
        silent
done

for t in rules_read memory_recall system_model_search system_model_query system_model_fetch system_model_schema system_model_history vendor_search vendor_info vendor_read vendor_status; do
    run_case "$t is silent" \
        "{\"tool_name\":\"mcp__plugin_bonez_bonez__$t\",\"tool_input\":{\"op\":\"save\"}}" \
        silent
done

# The old names are no longer gated: the removal is deliberate. A fresh install
# never sees them, and the gate does not inspect `op` any more.
run_case "old graph_write is silent" \
    '{"tool_name":"mcp__plugin_bonez_bonez__graph_write","tool_input":{"op":"remember","content":"x"}}' \
    silent
run_case "old rules with op save is silent" \
    '{"tool_name":"mcp__bonez__rules","tool_input":{"op":"save","name":"x","content":"y"}}' \
    silent
run_case "old memory with op save is silent" \
    '{"tool_name":"mcp__bonez__memory","tool_input":{"op":"save","content":"y"}}' \
    silent

# The Claude hooks.json matcher is the first filter: it must select the two
# write tools and leave everything else to the normal flow.
matcher="$(sed -n 's/.*"matcher": "\(__[^"]*\)".*/\1/p' "$HERE/../hooks/hooks.json" | head -1)"
for t in memory_save rules_write; do
    if [[ "mcp__plugin_bonez_bonez__$t" =~ $matcher ]]; then
        pass=$((pass + 1)); printf "  ok   hooks.json matcher selects %s\n" "$t"
    else
        fail=$((fail + 1)); printf "  FAIL hooks.json matcher (%s) misses %s\n" "$matcher" "$t"
    fi
done
for t in rules_read memory_recall system_model_fetch graph_write rules memory; do
    if [[ "mcp__plugin_bonez_bonez__$t" =~ $matcher ]]; then
        fail=$((fail + 1)); printf "  FAIL hooks.json matcher selects %s\n" "$t"
    else
        pass=$((pass + 1)); printf "  ok   hooks.json matcher leaves %s alone\n" "$t"
    fi
done

# --- Cursor leg (beforeMCPExecution) -------------------------------------
#
# Cursor speaks a different protocol on both ends: it keeps `mcp_server_name`
# separate from a BARE `tool_name`, documents `tool_input` as a JSON *string*,
# and expects a flat `{"permission":"ask"}` reply rather than Claude Code's
# nested `hookSpecificOutput`. It also sets no CLAUDE_PLUGIN_ROOT, so these
# cases deliberately run without one.
cursor_run_case() {
    local name="$1" payload="$2" expected="$3" expected_tool="${4:-}"
    local out status
    out="$(env -i PATH="$PATH" bash "$HOOK" <<<"$payload")"
    status=$?

    local ok=1
    if [[ "$expected" == "silent" ]]; then
        [[ -z "$out" && $status -eq 0 ]] || ok=0
    else
        # The Cursor shape, asserted explicitly — a Claude-shaped reply here
        # would be silently useless to Cursor, so the needle must not be shared.
        # camelCase is the authoritative spelling (cursor-hooks types'
        # HookPermissionResponse); snake_case is what the docs page prints. Both
        # are emitted, and both are asserted so neither can be dropped silently.
        [[ $status -eq 0 \
           && "$out" == *'"permission":"ask"'* \
           && "$out" == *'"userMessage"'* \
           && "$out" == *'"agentMessage"'* \
           && "$out" == *'"user_message"'* \
           && "$out" == *"bonez ${expected_tool} writes"* ]] || ok=0
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

# Cursor payload: `tool_input` as the documented JSON STRING (escaped quotes).
cursor_call() {
    local tool="$1" server="${2:-bonez}"
    printf '{"hook_event_name":"beforeMCPExecution","mcp_server_name":"%s","tool_name":"%s","tool_input":"{\\"content\\":\\"x\\"}"}' \
        "$server" "$tool"
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

run_case "non-bonez tool is ignored" \
    '{"tool_name":"Bash","tool_input":{"command":"echo save"}}' \
    silent

# --- an event name nested in the tool input must not pick the protocol ---
#
# The tool input is model-controlled. A `beforeMCPExecution` key inside it used
# to route a Claude Code call to the Cursor answer shape, which Claude Code
# ignores: the write ran with no prompt.
run_case "memory_save with a nested Cursor event name still gets Claude Code's prompt" \
    '{"hook_event_name":"PreToolUse","tool_name":"mcp__plugin_bonez_bonez__memory_save","tool_input":{"about":{"hook_event_name":"beforeMCPExecution"}}}' \
    prompt memory_save

run_case "rules_write with a nested Cursor event name still gets Claude Code's prompt" \
    '{"hook_event_name":"PreToolUse","tool_name":"mcp__plugin_bonez_bonez__rules_write","tool_input":{"x":{"hook_event_name":"beforeMCPExecution"}}}' \
    prompt rules_write

# --- vendor_write is deliberately NOT gated ---
#
# vendor_write runs an operation that changes state, and the gateway has its own
# approval step for those (`vendor_status` checks a run that waits). The plugin's
# own publish runs through it too, so a prompt here would fire on every push. The
# README ("Vendor operations") and the using-vendor-operations skill make the agent ask
# the user in words instead. These cases pin that boundary so a half-gate cannot
# appear unnoticed: if the gate is ever extended to vendor_write, flip them and the README.

run_case "vendor_write is not gated: a write operation is silent" \
    '{"tool_name":"mcp__plugin_bonez_bonez__vendor_write","tool_input":{"operation_id":"linear.issue.create.v1","input":{"title":"x"}}}' \
    silent

run_case "vendor_search is not gated either" \
    '{"tool_name":"mcp__plugin_bonez_bonez__vendor_search","tool_input":{"query":"issue create","vendor":"linear"}}' \
    silent

cursor_run_case "cursor: vendor_write is not gated" \
    '{"hook_event_name":"beforeMCPExecution","mcp_server_name":"bonez","tool_name":"vendor_write","tool_input":"{\"operation_id\":\"database.execute.v1\",\"input\":{}}"}' \
    silent

# --- BONEZ_MCP_GATE_DISABLE turns the gate off entirely ---

run_case "disable=1 silences a memory_save" \
    '{"tool_name":"mcp__bonez__memory_save","tool_input":{}}' \
    silent "" \
    BONEZ_MCP_GATE_DISABLE="1"

run_case "disable=0 leaves the gate active" \
    '{"tool_name":"mcp__bonez__memory_save","tool_input":{}}' \
    prompt memory_save \
    BONEZ_MCP_GATE_DISABLE="0"

run_case "disable=1 silences a rules_write too" \
    '{"tool_name":"mcp__bonez__rules_write","tool_input":{}}' \
    silent "" \
    BONEZ_MCP_GATE_DISABLE="1"

# --- harness detection: only Claude Code and Cursor get the prompt ---

# Codex sets its native PLUGIN_ROOT; the gate must stand down there.
run_case "PLUGIN_ROOT set (Codex) silences a memory_save" \
    '{"tool_name":"mcp__bonez__memory_save","tool_input":{}}' \
    silent "" \
    PLUGIN_ROOT="/tmp/codex-plugin-root"

# No CLAUDE_PLUGIN_ROOT at all = not Claude Code; the gate must stand down.
out="$(env -i PATH="$PATH" bash "$HOOK" <<<'{"tool_name":"mcp__bonez__memory_save","tool_input":{}}')"
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
    '{"tool_name":"mcp__bonez__memory_save"}' \
    '{"tool_name":"mcp__bonez__memory_save","tool_input":{"con' \
    '{"tool_name":"mcp__bonez__memory_save","tool_input":{}}'
do
    env -i PATH="$PATH" CLAUDE_PLUGIN_ROOT="$PLUGIN_DIR" bash "$HOOK" <<<"$_payload" >/dev/null 2>&1
    if (( $? != 2 )); then
        pass=$((pass + 1)); printf "  ok   never exits 2 (block) for: %q\n" "$_payload"
    else
        fail=$((fail + 1)); printf "  FAIL exited 2 (would block) for: %q\n" "$_payload"
    fi
done

# --- Cursor: beforeMCPExecution ---

cursor_run_case "cursor: memory_save prompts" \
    "$(cursor_call memory_save)" prompt memory_save

cursor_run_case "cursor: rules_write prompts" \
    "$(cursor_call rules_write)" prompt rules_write

cursor_run_case "cursor: rules_read is silent" \
    "$(cursor_call rules_read)" silent

cursor_run_case "cursor: old graph_write is silent" \
    "$(cursor_call graph_write)" silent

cursor_run_case "cursor: old rules with op save is silent" \
    '{"hook_event_name":"beforeMCPExecution","mcp_server_name":"bonez","tool_name":"rules","tool_input":{"op":"save"}}' \
    silent

# The server identity is the ONLY filter on this leg (Cursor's hooks.json
# carries no matcher), so a same-named tool on someone else's server must not
# inherit our prompt.
cursor_run_case "cursor: another server's memory_save is ignored" \
    "$(cursor_call memory_save othervendor)" silent

cursor_run_case "cursor: a renamed server key containing bonez prompts" \
    "$(cursor_call memory_save my-bonez-prod)" prompt memory_save

cursor_run_case "cursor: a non-write bonez tool is ignored" \
    "$(cursor_call system_model_search)" silent

# tool_input as a real object rather than the documented string — tolerated
# either way.
cursor_run_case "cursor: object-valued tool_input still prompts" \
    '{"hook_event_name":"beforeMCPExecution","mcp_server_name":"bonez","tool_name":"rules_write","tool_input":{"name":"x"}}' \
    prompt rules_write

# Protocol is chosen by hook_event_name, never by luck: a Claude-shaped payload
# reaching the Cursor helper (which sets no CLAUDE_PLUGIN_ROOT) stays silent
# rather than being answered in the wrong shape.
cursor_run_case "cursor: PreToolUse payload without plugin root is silent" \
    '{"hook_event_name":"PreToolUse","tool_name":"mcp__bonez__memory_save","tool_input":{}}' \
    silent

# Server identification is not settled across Cursor's own sources: the docs
# document `mcp_server_name`, the published types carry `url`/`command` and no
# server name at all. Both must work, or the gate silently never fires on one
# of them — and a write gate that never fires is worse than no gate.

cursor_run_case "cursor: identified by url when mcp_server_name is absent" \
    '{"hook_event_name":"beforeMCPExecution","tool_name":"memory_save","tool_input":"{}","url":"https://gateway.bonez.io/mcp"}' \
    prompt memory_save

cursor_run_case "cursor: a different server's url is ignored" \
    '{"hook_event_name":"beforeMCPExecution","tool_name":"memory_save","tool_input":"{}","url":"https://other.example/mcp"}' \
    silent

cursor_run_case "cursor: no identifying field at all is silent" \
    '{"hook_event_name":"beforeMCPExecution","tool_name":"memory_save","tool_input":"{}"}' \
    silent

# A flattened tool name identifies the server by itself, for a build that
# namespaces the way Claude Code does.
cursor_run_case "cursor: flattened tool name self-identifies" \
    '{"hook_event_name":"beforeMCPExecution","tool_name":"mcp__bonez__rules_write","tool_input":"{}"}' \
    prompt rules_write

# The plugin must be SELF-CONTAINED. Cursor resolves a plugin hook `command`
# from the plugin root, and a marketplace install copies that directory on its
# own — no repo behind it. Run the gate from a COPY placed elsewhere, because
# testing in-tree would pass even for a plugin that only works in-tree, and a
# gate that fails to exec lets writes through (Cursor fails open).
_standalone="$(mktemp -d)/bonez"
cp -R "$HERE/../cursor" "$_standalone"
plugin_out="$(cd "$_standalone" && env -i PATH="$PATH" ./hooks/gate-write.sh <<<'{"hook_event_name":"beforeMCPExecution","tool_name":"memory_save","tool_input":"{}","url":"https://gateway.bonez.io/mcp"}')"
rm -rf "$(dirname "$_standalone")"
if [[ "$plugin_out" == *'"permission":"ask"'* ]]; then
    pass=$((pass + 1)); printf "  ok   cursor: gate fires from a standalone plugin copy\n"
else
    fail=$((fail + 1)); printf "  FAIL cursor: plugin is not self-contained (stdout=%q)\n" "$plugin_out"
fi

# And the copy must not drift from the canonical gate, or the two protocols
# diverge silently.
if cmp -s "$HERE/../hooks/gate-write.sh" "$HERE/../cursor/hooks/gate-write.sh"; then
    pass=$((pass + 1)); printf "  ok   cursor: plugin gate is byte-identical to the canonical one\n"
else
    fail=$((fail + 1)); printf "  FAIL cursor: cursor/hooks/gate-write.sh has drifted\n"
fi

# --- summary ---

echo
echo "Passed: $pass  Failed: $fail"
(( fail == 0 ))
