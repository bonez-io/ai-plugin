#!/usr/bin/env bash
# Tests that the Codex plugin asks before bonez writes (approval_mode prompt in codex/.mcp.json) and that
# nothing in the repo sets approval_mode to approve, which runs the tool without asking.
# The assertions live in tests/codex_approval.test.mjs (Node's built-in runner).
#
# Offline.
#
#     ./tests/test_codex_approval.sh

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "Running Codex write-approval tests..."
node --test "$HERE/codex_approval.test.mjs"
