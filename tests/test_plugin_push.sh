#!/usr/bin/env bash
# Tests for bin/bonez-plugin-push.mjs (one-command plugin publish). The assertions live in
# tests/plugin_push.test.mjs (the API-key lane) and tests/plugin_signin.test.mjs (the browser sign-in
# lane) - Node's built-in runner, with a local http server standing in for the gateway; this wrapper
# gives CI and local runs the repo's one-entrypoint-per-test-file shape.
#
# Offline.
#
#     ./tests/test_plugin_push.sh

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "Running bonez-plugin-push.mjs tests..."
node --test "$HERE/plugin_push.test.mjs" "$HERE/plugin_signin.test.mjs"
