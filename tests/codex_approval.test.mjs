// Codex asks before a bonez write because codex/.mcp.json sets approval_mode to prompt on the write tools.
//
// Codex's approval_mode values: auto (default, Codex decides), prompt (asks before every call to the
// tool), writes (asks for tools not marked read-only), approve (runs WITHOUT asking). The repo once told
// people to set "approve" as a hard stop, which turns prompting off. These tests pin the shipped setting
// and keep that wrong advice out of every text file.
//
// Offline and dependency-free (Node's built-in runner).
// Run: node --test tests/codex_approval.test.mjs   (or ./tests/test_codex_approval.sh)
import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")

test("codex/.mcp.json asks before graph_write and rules", () => {
  const server = JSON.parse(readFileSync(join(REPO, "codex", ".mcp.json"), "utf8")).mcpServers.bonez
  assert.equal(server.tools?.graph_write?.approval_mode, "prompt")
  assert.equal(server.tools?.rules?.approval_mode, "prompt")
})

test("no file tells anyone to set approval_mode to approve (it runs the tool without asking)", () => {
  // The TOML, JSON and default_tools_approval_mode spellings of "set approval_mode to approve". Nothing
  // in this file spells it out, so the scan needs no exception for itself.
  const wrong = /approval_mode"?\s*[=:]\s*["']?approve\b/
  const hits = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (wrong.test(readFileSync(path, "latin1"))) hits.push(relative(REPO, path))
    }
  }
  walk(REPO)
  assert.deepEqual(hits, [], "these files set approval_mode to approve, which turns prompting off: use prompt")
})
