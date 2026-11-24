#!/usr/bin/env node
// This repository is public. Fails when a tracked file, or a pull request's title and commit messages, name
// something that belongs to Bonez's private side: an issue-tracker id, a private repository, a customer, an
// internal host, a cloud account, or a note about how Bonez runs its own environments.
//
//   node scripts/check-public-hygiene.mjs                  every tracked file (git ls-files)
//   node scripts/check-public-hygiene.mjs --text <file>    one text, such as a pull request title and body
//   node scripts/check-public-hygiene.mjs --commits <a..b> the messages of the commits in a range
//
// A hit that has to stay goes in .public-hygiene-allow, with the reason. Exit 0 clean, 1 hits, 2 usage.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

// Names that must not appear here, and must not be published by this file either, are held as the first 16 hex
// characters of the SHA-256 of the lower-cased word. Every word of a line is hashed whole and by its `-`/`_` parts.
export const hashWord = (word) => createHash("sha256").update(word.toLowerCase()).digest("hex").slice(0, 16)
const hashed = (...hashes) => ({ hashes: new Set(hashes) })

// Each rule: an id (what the allow-list names), a pattern, and what it catches.
export const RULES = [
  ["tracker-id", /\b1SI-\d+\b/gi, "an internal issue-tracker id"],
  ["tracker-link", /linear\.app\//gi, "a link to the internal issue tracker"],
  ["private-repo", /\bbonez-(?:core|infra|admin|gtm|gateway|pipeline|wire|conductor|graph|graph-engine|debugger|inference)\b|\bharness-(?:ui|core)\b|\bpayzeno-demo\b|\bqueue-sandbox\b/gi, "a private repository"],
  ["customer", hashed("d220707e92fa1fee", "60396123d3a3ac40", "3bb0c5d6e10489a7", "b00cd9ac34b26928", "bb720da1ac0c4818",
    "ff3636901a352bfc", "4050a71ef74952fb", "a1e6f70ed7c20ef3"), "a customer or demo-organization name"],
  ["internal-host", /\b[a-z0-9-]+\.sbx\.bonez\.io\b|\b(?:qa|dev|staging|internal)\.(?:[a-z0-9-]+\.)*bonez\.io\b|\bauth\.(?:qa|dev)\.|\bbonez-(?:qa|dev)\b/gi, "an internal host or environment"],
  ["aws", /\barn:aws[a-z-]*:|\.dkr\.ecr\.|\bs3:\/\/|\.s3[.-][a-z0-9.-]*amazonaws\.com|\b(?:aws[_ -]?)?account[_ -]?id\W{0,4}\d{12}\b|\bssm:\/|\/aws\/reference\/secretsmanager|\bparameter\/bonez\//gi, "a cloud account, resource name or secret path"],
  ["backend-env", /\bBONEZ_MCP_OAUTH_CLIENT_ID\b|\bmcp_install\b|\bBONEZ_AUTH0_[A-Z_]+\b|\bBONEZ_ADMIN_ORIGINS\b|\bBONEZ_PLUGIN_REF\b/g, "a backend-only setting"],
  ["staff-name", hashed("7ca7b9cc82c9d0f4", "b932c8753800342b", "182b8dc868a124bf"), "a staff name"],
  ["staff-address", /\b(?!support@|privacy@|security@)[a-z0-9._%+-]+@bonez\.io\b/g, "a staff address"],
  ["process", /\b(?:prod|dev|qa) tenant\b|\bplugin-lab\b|\bbonez-cluster\b|\bdev cluster\b|\btenant agents\b/gi, "a note about Bonez's own environments"],
]

const ALLOW_FILE = ".public-hygiene-allow"
// This file and the allow-list spell the patterns out; they are the only files exempt as a whole.
const SELF = new Set(["scripts/check-public-hygiene.mjs", ALLOW_FILE])

// .public-hygiene-allow: one entry per line, `<path> | <rule id> | <exact text> | <reason>`. `*` as the path
// allows that text in every file. A line without a reason is refused, so every exception says why it stays.
export function loadAllow(text) {
  const entries = []
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith("#")) return
    const parts = line.split("|").map((s) => s.trim())
    if (parts.length !== 4 || parts.some((p) => !p)) throw new Error(`${ALLOW_FILE}:${i + 1}: want "<path> | <rule> | <text> | <reason>"`)
    const [path, rule, match] = parts
    if (!RULES.some(([id]) => id === rule)) throw new Error(`${ALLOW_FILE}:${i + 1}: unknown rule ${rule}`)
    entries.push({ path, rule, match })
  })
  return entries
}

const allowed = (allow, path, rule, match) =>
  allow.some((e) => (e.path === "*" || e.path === path) && e.rule === rule && e.match.toLowerCase() === match.toLowerCase())

function* matches(line, matcher) {
  if (matcher instanceof RegExp) {
    for (const m of line.matchAll(matcher)) yield m[0]
    return
  }
  for (const [word] of line.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]*/g)) {
    const parts = new Set([word, ...word.split(/[-_]/), ...word.split("_")])
    for (const part of parts) if (part && matcher.hashes.has(hashWord(part))) yield part
  }
}

export function scanText(text, where, allow = [], rules = RULES) {
  const hits = []
  text.split("\n").forEach((line, i) => {
    for (const [rule, matcher, what] of rules) {
      for (const match of matches(line, matcher)) {
        if (!allowed(allow, where, rule, match)) hits.push({ where, line: i + 1, rule, match, what })
      }
    }
  })
  return hits
}

function main(argv) {
  const allow = loadAllow(readFileSync(ALLOW_FILE, "utf8"))
  let hits = []
  if (argv[0] === "--text" && argv[1]) {
    hits = scanText(readFileSync(argv[1], "utf8"), "text")
  } else if (argv[0] === "--commits" && argv[1]) {
    const log = execFileSync("git", ["log", "--format=%H%n%B%n--end--", argv[1]], { encoding: "utf8" })
    for (const block of log.split("--end--\n").filter((b) => b.trim())) {
      const [sha, ...body] = block.split("\n")
      hits.push(...scanText(body.join("\n"), `commit ${sha.slice(0, 10)}`))
    }
  } else if (argv.length === 0) {
    const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)
    for (const file of files) {
      if (SELF.has(file) || /\.(png|jpe?g|gif|webp|ico|zip|gz)$/i.test(file)) continue
      let text
      try {
        text = readFileSync(file, "utf8")
      } catch {
        continue // a submodule or a file deleted in the working tree
      }
      hits.push(...scanText(text, file, allow))
    }
  } else {
    console.error("usage: check-public-hygiene.mjs [--text <file> | --commits <range>]")
    return 2
  }
  for (const h of hits) console.log(`${h.where}:${h.line}: ${h.rule}: "${h.match}" (${h.what})`)
  if (hits.length) {
    console.error(`\n${hits.length} internal reference(s). This repository is public: reword them, or, if one must stay, add it to ${ALLOW_FILE} with the reason.`)
    return 1
  }
  console.log("ok: no internal references")
  return 0
}

if (process.argv[1]?.endsWith("check-public-hygiene.mjs")) process.exitCode = main(process.argv.slice(2))
