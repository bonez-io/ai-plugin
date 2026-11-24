#!/usr/bin/env bash
# Tests for which Bonez CLI client a sign-in uses: the one the gateway names in /auth/config (bin/lib/client-id.mjs),
# else the shipped one, which every static MCP config names exactly so the gateway's install script can swap it.
# The assertions live in tests/client_id.test.mjs (Node's built-in runner).
#
# Offline.
#
#     ./tests/test_client_id.sh

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "Running client id tests..."
node --test "$HERE/client_id.test.mjs"
