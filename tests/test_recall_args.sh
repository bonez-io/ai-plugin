#!/usr/bin/env bash
# Tests what the recall hook asks the agent to send to memory_recall on the three legs: the repository and
# the task on the seed call, `message` next to `refs` on a file lookup, never an empty call, and no prompt
# text in hook output. In Claude Code the reminder comes on a session's first prompt only.
# The assertions live in tests/recall_args.test.mjs (Node's built-in runner); this wrapper gives CI and local
# runs the repo's one-entrypoint-per-test-file shape.
#
# Offline.
#
#     ./tests/test_recall_args.sh

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "Running recall-argument tests..."
node --test "$HERE/recall_args.test.mjs"
