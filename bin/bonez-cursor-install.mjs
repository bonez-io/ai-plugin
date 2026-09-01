#!/usr/bin/env node
// Installs the bonez leg into Cursor.
//
// Cursor has no plugin manager — no `claude plugin install`, no marketplace — so
// "install" here means writing four things into the places Cursor already reads:
//
//   ~/.cursor/mcp.json      the MCP server entry (OAuth by default, no key)
//   ~/.cursor/hooks.json    the beforeMCPExecution write gate
//   ~/.agents/skills/       the 8 skills (SKILL.md — the same format and path Codex reads)
//   ~/.cursor/commands/     /bonez-context and /bonez-search
//
// Everything is MERGED, never overwritten: `mcp.json` and `hooks.json` routinely
// already hold other servers and other hooks, and clobbering somebody's editor
// config is not an acceptable failure mode for a convenience script. Every file
// it touches is backed up next to itself first, and re-running is a no-op that
// reports "already current" rather than duplicating entries.
//
// Usage:
//   node bin/bonez-cursor-install.mjs [--dry-run] [--project <dir>] [--url <mcp url>]
//
//   --dry-run    print what would change and touch nothing
//   --project    install into <dir>/.cursor instead of ~/.cursor (one repo only)
//   --url        point at a different gateway (default https://gateway.bonez.io/mcp)

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SELF = fileURLToPath(import.meta.url)
const PLUGIN_ROOT = resolve(dirname(SELF), "..")
const DEFAULT_URL = "https://gateway.bonez.io/mcp"

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")
const projectDir = readFlag("--project")
const mcpUrl = readFlag("--url") || DEFAULT_URL

function readFlag(name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined
}

// Project installs keep everything under <project>/.cursor, which is what you want
// when the config is checked in. A user install splits: Cursor config lives in
// ~/.cursor, but skills go to ~/.agents/skills — the shared location Cursor AND
// Codex both read, so the two legs stop keeping separate copies of the same 8 files.
const cursorDir = projectDir ? join(resolve(projectDir), ".cursor") : join(homedir(), ".cursor")
const skillsDir = projectDir ? join(resolve(projectDir), ".agents", "skills") : join(homedir(), ".agents", "skills")
const commandsDir = join(cursorDir, "commands")

const changes = []
const notes = []

function readJson(path) {
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, "utf8").trim()
    return raw ? JSON.parse(raw) : {}
  } catch (err) {
    // A malformed file is the one case where merging is impossible: we cannot
    // preserve what we cannot parse. Stop rather than replace it wholesale.
    console.error(`bonez: ${path} is not valid JSON — fix or move it, then re-run.`)
    console.error(`       (${err.message})`)
    process.exit(1)
  }
}

function backup(path) {
  if (!existsSync(path) || dryRun) return
  const dest = `${path}.bonez-backup`
  if (!existsSync(dest)) copyFileSync(path, dest)
}

function writeJson(path, value) {
  if (dryRun) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

// --------------------------------------------------------------- mcp.json

const mcpPath = join(cursorDir, "mcp.json")
const mcp = readJson(mcpPath)
mcp.mcpServers = mcp.mcpServers || {}
const desiredServer = {
  url: mcpUrl,
  headers: { "x-bonez-mcp-consumer": "cursor-plugin" },
}
if (JSON.stringify(mcp.mcpServers.bonez) === JSON.stringify(desiredServer)) {
  notes.push(`mcp.json          already current (${Object.keys(mcp.mcpServers).length} server(s), bonez among them)`)
} else {
  const existing = Object.keys(mcp.mcpServers).filter((k) => k !== "bonez")
  mcp.mcpServers.bonez = desiredServer
  backup(mcpPath)
  writeJson(mcpPath, mcp)
  changes.push(`mcp.json          + bonez  (kept: ${existing.length ? existing.join(", ") : "nothing else"})`)
}

// --------------------------------------------------------------- hooks.json

const hooksPath = join(cursorDir, "hooks.json")
const hooks = readJson(hooksPath)
hooks.version = hooks.version || 1
hooks.hooks = hooks.hooks || {}
const gatePath = join(PLUGIN_ROOT, "hooks", "gate-write.sh")
const desiredHook = { type: "command", command: gatePath, timeout: 5, failClosed: false }

const before = Array.isArray(hooks.hooks.beforeMCPExecution) ? hooks.hooks.beforeMCPExecution : []
// Identify OUR entry by the script it points at, not by position: the user may
// have their own beforeMCPExecution hooks, and a re-run after moving the checkout
// must update the stale path rather than append a second copy.
const mine = before.findIndex((h) => typeof h?.command === "string" && h.command.includes("gate-write.sh"))
if (mine >= 0 && JSON.stringify(before[mine]) === JSON.stringify(desiredHook)) {
  notes.push(`hooks.json        already current (${before.length} beforeMCPExecution hook(s))`)
} else {
  if (mine >= 0) before[mine] = desiredHook
  else before.push(desiredHook)
  hooks.hooks.beforeMCPExecution = before
  backup(hooksPath)
  writeJson(hooksPath, hooks)
  changes.push(`hooks.json        ${mine >= 0 ? "~" : "+"} write gate -> ${gatePath}`)
}

// --------------------------------------------------------------- skills

function copyTree(src, dest) {
  let copied = 0
  for (const entry of readdirSync(src)) {
    const s = join(src, entry)
    const d = join(dest, entry)
    if (statSync(s).isDirectory()) {
      if (!dryRun) mkdirSync(d, { recursive: true })
      copied += copyTree(s, d)
    } else {
      if (!dryRun) copyFileSync(s, d)
      copied += 1
    }
  }
  return copied
}

const srcSkills = join(PLUGIN_ROOT, "skills")
const skillNames = readdirSync(srcSkills).filter((n) => existsSync(join(srcSkills, n, "SKILL.md")))
if (!dryRun) mkdirSync(skillsDir, { recursive: true })
for (const name of skillNames) {
  if (!dryRun) mkdirSync(join(skillsDir, name), { recursive: true })
  copyTree(join(srcSkills, name), join(skillsDir, name))
}
changes.push(`skills            ${skillNames.length} -> ${skillsDir}`)

// --------------------------------------------------------------- commands

const srcCommands = join(PLUGIN_ROOT, "cursor", "commands")
if (!dryRun) mkdirSync(commandsDir, { recursive: true })
const commandFiles = readdirSync(srcCommands).filter((f) => f.endsWith(".md"))
for (const f of commandFiles) {
  if (!dryRun) copyFileSync(join(srcCommands, f), join(commandsDir, f))
}
changes.push(`commands          ${commandFiles.map((f) => `/${f.replace(/\.md$/, "")}`).join(", ")} -> ${commandsDir}`)

// --------------------------------------------------------------- report

console.log(dryRun ? "bonez -> Cursor (dry run — nothing written)\n" : "bonez -> Cursor\n")
for (const c of changes) console.log(`  ${c}`)
for (const n of notes) console.log(`  ${n}`)
console.log()
if (!dryRun) console.log("  Backups of any pre-existing mcp.json / hooks.json are alongside them as *.bonez-backup.")
console.log("  Restart Cursor, then run /bonez-context. First tool call opens the browser sign-in.")
console.log("  Session capture is NOT wired on the Cursor leg — see the README.")
