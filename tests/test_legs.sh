#!/usr/bin/env bash
# Tests that the Cursor and Codex legs carry what the creating-a-plugin skill and the new-plugin flow
# need: byte copies of the hash and push tools, the skill folder, and a flow written for the harness (a command
# on Cursor, the new-plugin skill on Codex, whose plugins cannot ship custom prompts).
# The assertions live in tests/legs.test.mjs (Node's built-in runner); this wrapper gives CI and local
# runs the repo's one-entrypoint-per-test-file shape.
#
# It also holds the three legs to one skill set with identical descriptions, the two agent skills
# (suggesting-agents, creating-an-agent) and the always-loaded guidance (AGENTS.md, the Cursor rule).
#
# Offline.
#
#     ./tests/test_legs.sh

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "Running plugin-creator and skill leg tests..."
node --test "$HERE/legs.test.mjs"
