#!/usr/bin/env bash
# Shim. Cursor resolves a plugin's hook `command` relative to the PLUGIN root
# (cursor/), but the gate itself is shared with the Claude Code leg and lives at
# the repo root — one script speaking both protocols, so there is exactly one
# place where "which ops are writes" is decided. Rather than keep a second copy
# here and let the two drift, exec the real one.
exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)/hooks/gate-write.sh" "$@"
