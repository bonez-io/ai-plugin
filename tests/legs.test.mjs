// The plugin-creator on the three legs (Claude Code at the repo root, Cursor in cursor/, Codex in codex/).
//
// A marketplace install copies one leg's folder on its own: there is no repo behind it. So the Cursor and
// Codex legs carry their own byte copy of the hash and push tools (and their lib), their own copy of the
// creating-a-plugin skill, and a command (Cursor) or prompt (Codex) that runs the same steps as
// commands/new-plugin.md. These tests keep the copies from drifting and prove a copy works alone.
//
// Offline and dependency-free (Node's built-in runner).
// Run: node --test tests/legs.test.mjs   (or ./tests/test_legs.sh)
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { VECTORS, materialize } from "./lib/vectors.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (...parts) => readFileSync(join(REPO, ...parts), "utf8")
const SKILL = ["skills", "creating-a-plugin"]

// What each leg calls the flow, and where the flow's file is (relative to the leg's plugin folder).
const LEGS = {
  cursor: { command: "/bonez-new-plugin", flow: "commands/bonez-new-plugin.md", others: [/Codex/, /\/prompts:/, /CLAUDE_PLUGIN_ROOT/, /\/bonez:/] },
  codex: { command: "/prompts:new-plugin", flow: "prompts/new-plugin.md", others: [/Cursor/, /(^|[\s`(])\/bonez-[a-z]/, /CLAUDE_PLUGIN_ROOT/, /\/bonez:/] },
}
// The tools every leg ships, as bin/ paths.
const TOOLS = ["bonez-package-hash.mjs", "bonez-plugin-push.mjs", "lib/plugin-tree.mjs"]

const roots = []
process.on("exit", () => roots.forEach((d) => rmSync(d, { recursive: true, force: true })))
function freshDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `bonez-${prefix}-`))
  roots.push(dir)
  return dir
}

// Every file under `dir`, as POSIX paths relative to it.
function filesUnder(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else out.push(relative(dir, join(d, e.name)).split("\\").join("/"))
    }
  }
  walk(dir)
  return out.sort()
}

describe("the hash and push tools are byte copies in every leg", () => {
  for (const leg of Object.keys(LEGS)) {
    for (const tool of TOOLS) {
      test(`${leg}/bin/${tool} is bin/${tool}`, () => {
        assert.ok(existsSync(join(REPO, leg, "bin", tool)), `${leg}/bin/${tool} is missing: cp bin/${tool} ${leg}/bin/${tool}`)
        assert.equal(read(leg, "bin", tool), read("bin", tool), `${leg}/bin/${tool} has drifted from bin/${tool}: re-copy it`)
      })
    }
  }
})

describe("the creating-a-plugin skill in every leg", () => {
  for (const leg of Object.keys(LEGS)) {
    test(`${leg}: the same files, byte for byte, except SKILL.md`, () => {
      const canonical = filesUnder(join(REPO, ...SKILL))
      assert.deepEqual(filesUnder(join(REPO, leg, ...SKILL)), canonical, "the two skill folders hold different files")
      for (const file of canonical.filter((f) => f !== "SKILL.md")) {
        assert.equal(read(leg, ...SKILL, file), read(...SKILL, file), `${leg}/${SKILL.join("/")}/${file} has drifted: re-copy it`)
      }
    })

    // The fork differs from the Claude Code SKILL.md in one hand-written line (the pointer to the flow) and
    // in the mechanical rewrites below. Nothing else may differ, so a fix to the canonical skill must be
    // carried over, and this says which line did not follow.
    test(`${leg}: SKILL.md is the canonical one with the tool paths and the command name rewritten`, () => {
      const { command, flow } = LEGS[leg]
      const canonical = read(...SKILL, "SKILL.md").split("\n")
      const fork = read(leg, ...SKILL, "SKILL.md").split("\n")
      assert.equal(fork.length, canonical.length, "a line was added or removed")
      let pointers = 0
      canonical.forEach((line, i) => {
        if (line.includes("commands/new-plugin.md")) {
          pointers++
          assert.ok(fork[i].includes(command) && fork[i].includes(`<skill folder>/../../${flow}`), `line ${i + 1} must point at ${flow} as ${command}: ${fork[i].slice(0, 160)}`)
          assert.ok(!fork[i].includes("CLAUDE_PLUGIN_ROOT"), `line ${i + 1} still names CLAUDE_PLUGIN_ROOT`)
          return
        }
        const expected = line.replaceAll("/bonez:new-plugin", command).replaceAll("${CLAUDE_PLUGIN_ROOT}", "<skill folder>/../..")
        assert.equal(fork[i], expected, `line ${i + 1} of ${leg}/${SKILL.join("/")}/SKILL.md should be the canonical line with the paths rewritten`)
      })
      assert.equal(pointers, 1, "the canonical SKILL.md must point at the flow on exactly one line")
    })
  }
})

describe("the new-plugin flow in every leg", () => {
  const steps = (text) => [...text.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`)

  for (const [leg, { command, flow, others }] of Object.entries(LEGS)) {
    test(`${leg}: ${flow} has the frontmatter the harness reads, names its command, and holds nothing of another harness`, () => {
      const text = read(leg, ...flow.split("/"))
      assert.ok(text.startsWith("---\n"), "frontmatter")
      assert.match(text.split("\n---\n")[0], /^description: .+/m)
      assert.ok(text.includes(`# ${command}`), `the title must be ${command}`)
      for (const foreign of others) assert.doesNotMatch(text, foreign, `${flow} mentions ${foreign}, which is not this harness`)
    })

    test(`${leg}: the steps are the Claude Code command's steps, in the same order`, () => {
      assert.deepEqual(steps(read(leg, ...flow.split("/"))), steps(read("commands", "new-plugin.md")))
    })

    test(`${leg}: every file the flow and the skill name under <skill folder>/../../ exists in the leg`, () => {
      const mentioned = new Set()
      for (const text of [read(leg, ...flow.split("/")), read(leg, ...SKILL, "SKILL.md")]) {
        for (const m of text.matchAll(/<skill folder>\/\.\.\/\.\.\/([A-Za-z0-9_./-]+?)(?=["`\s;:,)]|$)/g)) mentioned.add(m[1])
      }
      for (const tool of TOOLS) mentioned.add(`bin/${tool}`)
      assert.ok(mentioned.has("bin/bonez-plugin-push.mjs") && mentioned.has("bin/bonez-package-hash.mjs"))
      for (const file of mentioned) assert.ok(existsSync(join(REPO, leg, file)), `${leg}/${file} is named but not shipped`)
    })

    test(`${leg}: the flow's own commands are the Claude Code command's, with the paths rewritten`, () => {
      // The commands that run something: same text in the three flows once the plugin-root spelling is rewritten.
      const code = (text) => [...text.matchAll(/`(node "[^`]+"|bun [^`]+)`/g)].map((m) => m[1].replaceAll("${CLAUDE_PLUGIN_ROOT}", "<skill folder>/../.."))
      const mine = code(read(leg, ...flow.split("/")))
      const theirs = code(read("commands", "new-plugin.md"))
      for (const command of theirs.filter((c) => c.includes("<skill folder>") || c.startsWith("bun "))) {
        assert.ok(mine.includes(command), `${flow} lacks the command: ${command}`)
      }
    })
  }
})

// What a marketplace install gives the user: the leg's folder, copied somewhere on its own. The skill asks the
// agent to reach the tools as <skill folder>/../../bin/, so that is what is resolved here.
describe("a leg copied on its own works", () => {
  for (const leg of Object.keys(LEGS)) {
    test(`${leg}: the tools resolved from the skill folder hash a plugin folder like the shared vectors, and the scaffold copies`, () => {
      const standalone = join(freshDir(`leg-${leg}`), "bonez")
      cpSync(join(REPO, leg), standalone, { recursive: true })
      const skill = join(standalone, ...SKILL)
      const tool = (name) => join(skill, "..", "..", "bin", name)
      for (const vector of VECTORS) {
        const folder = materialize(vector, join(freshDir(`leg-${leg}-${vector.name}`), "pkg"))
        const r = spawnSync(process.execPath, [tool("bonez-package-hash.mjs"), folder], { encoding: "utf8" })
        assert.equal(r.status, 0, r.stderr)
        assert.equal(r.stdout, `${vector.tree_sha256}\n`, vector.name)
      }
      // The push tool starts (its lib resolves) and says what it is missing, without sending anything.
      const push = spawnSync(process.execPath, [tool("bonez-plugin-push.mjs"), "--status"], { encoding: "utf8", env: { ...process.env, BONEZ_URL: "", BONEZ_API_KEY: "" } })
      assert.equal(push.status, 2, push.stderr)
      assert.match(push.stderr, /BONEZ_URL is not set/)
      // Step 3.1 of the flow: copy the scaffold, .gitignore included.
      const target = join(freshDir(`leg-${leg}-scaffold`), "hello")
      const copy = spawnSync(process.execPath, ["-e", "require('fs').cpSync(process.argv[1], process.argv[2], { recursive: true })", join(skill, "templates"), target], { encoding: "utf8" })
      assert.equal(copy.status, 0, copy.stderr)
      assert.ok(existsSync(join(target, ".gitignore")) && existsSync(join(target, "scripts", "tree-hash.mjs")) && statSync(join(target, "src", "index.ts")).isFile())
      mkdirSync(join(target, "out"), { recursive: true })
    })
  }
})
