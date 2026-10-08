// The plugin-creator on the three legs (Claude Code at the repo root, Cursor in cursor/, Codex in codex/).
//
// A marketplace install copies one leg's folder on its own: there is no repo behind it. So the Cursor and
// Codex legs carry their own byte copy of the hash and push tools (and their lib), their own copy of the
// creating-a-plugin skill, and a command (Cursor) or a skill (Codex: a plugin cannot ship custom prompts, so
// the flow is the new-plugin skill) that runs the same steps as commands/new-plugin.md. These tests keep the
// copies from drifting and prove a copy works alone.
//
// It also pins what the three legs share about skills and always-loaded guidance: the same skill set, the same
// descriptions (a description is what makes a harness reach for a skill unasked), the two agent skills
// (suggesting-agents, creating-an-agent) and the lines in codex/AGENTS.md, cursor/AGENTS.md and the Cursor rule.
//
// Offline and dependency-free (Node's built-in runner).
// Run: node --test tests/legs.test.mjs   (or ./tests/test_legs.sh)
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { VECTORS, materialize } from "./lib/vectors.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (...parts) => readFileSync(join(REPO, ...parts), "utf8")
const SKILL = ["skills", "creating-a-plugin"]

// What each leg calls the flow, where the flow's file is (relative to the leg's plugin folder), how the
// creating-a-plugin SKILL.md reaches it, and which skill folder the flow's own `<skill folder>` means (the tools
// are two folders above either, the scaffold is in creating-a-plugin).
const LEGS = {
  cursor: {
    command: "/bonez-new-plugin",
    flow: "commands/bonez-new-plugin.md",
    flowRef: "<skill folder>/../../commands/bonez-new-plugin.md",
    skillFolder: ["skills", "creating-a-plugin"],
    templates: "<skill folder>/templates",
    others: [/Codex/, /\/prompts:/, /CLAUDE_PLUGIN_ROOT/, /\/bonez:/],
  },
  codex: {
    command: "$new-plugin",
    flow: "skills/new-plugin/SKILL.md",
    flowRef: "<skill folder>/../new-plugin/SKILL.md",
    skillFolder: ["skills", "new-plugin"],
    templates: "<skill folder>/../creating-a-plugin/templates",
    others: [/Cursor/, /Claude Code/, /(^|[\s`(])\/bonez-[a-z]/, /CLAUDE_PLUGIN_ROOT/, /\/bonez:/, /\/prompts:/, /\$ARGUMENTS/],
  },
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
      const { command, flowRef } = LEGS[leg]
      const canonical = read(...SKILL, "SKILL.md").split("\n")
      const fork = read(leg, ...SKILL, "SKILL.md").split("\n")
      assert.equal(fork.length, canonical.length, "a line was added or removed")
      let pointers = 0
      canonical.forEach((line, i) => {
        if (line.includes("commands/new-plugin.md")) {
          pointers++
          assert.ok(fork[i].includes(command) && fork[i].includes(flowRef), `line ${i + 1} must point at ${flowRef} as ${command}: ${fork[i].slice(0, 160)}`)
          assert.ok(!fork[i].includes("CLAUDE_PLUGIN_ROOT"), `line ${i + 1} still names CLAUDE_PLUGIN_ROOT`)
          return
        }
        const expected = line.replaceAll("/bonez:new-plugin", () => command).replaceAll("${CLAUDE_PLUGIN_ROOT}", "<skill folder>/../..")
        assert.equal(fork[i], expected, `line ${i + 1} of ${leg}/${SKILL.join("/")}/SKILL.md should be the canonical line with the paths rewritten`)
      })
      assert.equal(pointers, 1, "the canonical SKILL.md must point at the flow on exactly one line")
    })
  }
})

describe("the new-plugin flow in every leg", () => {
  const steps = (text) => [...text.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`)

  for (const [leg, { command, flow, others, templates }] of Object.entries(LEGS)) {
    test(`${leg}: ${flow} has the frontmatter the harness reads, names its command, and holds nothing of another harness`, () => {
      const text = read(leg, ...flow.split("/"))
      assert.ok(text.startsWith("---\n"), "frontmatter")
      const front = text.split("\n---\n")[0]
      assert.match(front, /^description: .+/m)
      if (flow.endsWith("/SKILL.md")) {
        // A skill is found by its name (the folder's) and picked by its description, a one-line YAML scalar.
        assert.match(front, new RegExp(`^name: ${flow.split("/").at(-2)}$`, "m"), "name must be the skill folder's name")
        const description = front.match(/^description: (.+)$/m)[1]
        assert.match(description, /Use when the user asks to create, build or upload a Bonez plugin/, "the description is what makes the harness pick this skill")
        assert.doesNotMatch(description, /: | #/, "a colon-space or a space-hash in the description breaks the YAML")
      }
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

    test(`${leg}: the flow copies the scaffold from the creating-a-plugin skill's templates, which the leg ships`, () => {
      assert.ok(read(leg, ...flow.split("/")).includes(`"${templates}"`), `${flow} must copy from "${templates}"`)
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
  for (const [leg, { skillFolder, templates }] of Object.entries(LEGS)) {
    test(`${leg}: the tools resolved from the skill folder hash a plugin folder like the shared vectors, and the scaffold copies`, () => {
      const standalone = join(freshDir(`leg-${leg}`), "bonez")
      cpSync(join(REPO, leg), standalone, { recursive: true })
      const skill = join(standalone, ...skillFolder)
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
      const copy = spawnSync(process.execPath, ["-e", "require('fs').cpSync(process.argv[1], process.argv[2], { recursive: true })", resolve(skill, templates.replace("<skill folder>/", "")), target], { encoding: "utf8" })
      assert.equal(copy.status, 0, copy.stderr)
      assert.ok(existsSync(join(target, ".gitignore")) && existsSync(join(target, "scripts", "tree-hash.mjs")) && statSync(join(target, "src", "index.ts")).isFile())
      mkdirSync(join(target, "out"), { recursive: true })
    })
  }
})

// ---- skills and always-loaded guidance, across the three legs ------------------------------------------------

// Where each leg keeps its skills. Codex also has new-plugin, the plugin creator, as a skill (it ships no commands).
const SKILL_ROOTS = { claude: "skills", cursor: "cursor/skills", codex: "codex/skills" }
const skillNames = (root) => readdirSync(join(REPO, ...root.split("/"))).sort()
const skillText = (root, name) => read(...root.split("/"), name, "SKILL.md")
const frontmatter = (text) => text.split("\n---\n")[0]
const descriptionOf = (text) => frontmatter(text).match(/^description: (.+)$/m)?.[1]
const AGENT_SKILLS = ["creating-an-agent", "suggesting-agents"]

describe("the skill set and the skill descriptions", () => {
  const canonical = skillNames("skills")

  test("every leg exposes the same skills (Codex also has new-plugin) and the two agent skills are among them", () => {
    assert.deepEqual(skillNames("cursor/skills"), canonical)
    assert.deepEqual(skillNames("codex/skills").filter((s) => s !== "new-plugin"), canonical)
    for (const skill of AGENT_SKILLS) assert.ok(canonical.includes(skill), `skills/${skill} is missing`)
  })

  for (const skill of AGENT_SKILLS) {
    test(`${skill} is the same file in all three legs`, () => {
      for (const leg of ["cursor/skills", "codex/skills"]) assert.equal(skillText(leg, skill), skillText("skills", skill), `${leg}/${skill} has drifted: re-copy it`)
    })
  }

  for (const [leg, root] of Object.entries(SKILL_ROOTS)) {
    for (const skill of skillNames(root)) {
      test(`${leg}: ${skill} has a name and a one-line description under 1000 characters that parses as YAML`, () => {
        const text = skillText(root, skill)
        assert.ok(text.startsWith("---\n"), "frontmatter")
        assert.match(frontmatter(text), new RegExp(`^name: ${skill}$`, "m"), "name must be the folder's name")
        const description = descriptionOf(text)
        assert.ok(description && description.trim().length > 0, "description must not be empty")
        // The description sits in the model's context every session; Codex refuses one over 1024 characters.
        assert.ok(description.length < 1000, `description is ${description.length} characters`)
        assert.doesNotMatch(description, /: | #|^["'&*!|>%@`]/, "a colon-space, a space-hash or a leading indicator breaks the YAML scalar")
      })
    }
  }

  test("the three legs carry the same description for every skill", () => {
    for (const skill of canonical) {
      for (const root of ["cursor/skills", "codex/skills"]) {
        assert.equal(descriptionOf(skillText(root, skill)), descriptionOf(skillText("skills", skill)), `${root}/${skill}: description differs from skills/${skill}`)
      }
    }
  })

  test("every description states the moment to reach for the skill", () => {
    // The old descriptions said what a skill does; the new ones say when to use it, in the user's or the agent's words.
    const triggers = {
      "finding-prior-art": /before you write non-trivial code/i,
      "impact-analysis": /before you change, rename or delete/i,
      "remembering": /something a teammate would want/i,
      "reviewing-with-org-rules": /before you tell the user a non-trivial change is ready/i,
      "session-context": /start of a task in an unfamiliar repo/i,
      "who-owns-what": /who owns/i,
      "using-the-tool-lake": /instead of guessing or asking the user to paste it/i,
    }
    for (const [skill, re] of Object.entries(triggers)) assert.match(descriptionOf(skillText("skills", skill)), re, skill)
  })
})

describe("suggesting-agents", () => {
  const text = skillText("skills", "suggesting-agents")
  const description = descriptionOf(text)

  test("its description names the moments: a recurring bug, a periodic manual task, a task to rerun", () => {
    for (const phrase of [/come back/, /keeps happening/, /again/, /regression/, /nightly agent/]) assert.match(description, phrase, "recurring bug")
    for (const phrase of [/by hand/, /dependency or CVE check/, /stale PRs/, /release notes/, /log or error sweep/, /docs-drift/, /post-deploy verification/, /scheduled agent/]) assert.match(description, phrase, "periodic task")
    assert.match(description, /run again/, "a task they will rerun")
    assert.match(description, /Never for one-off work/)
    assert.match(description, /Never create one without a yes/)
  })

  test("its body is the etiquette: once per session, two lines with the spec, never without a yes, prefer an existing agent", () => {
    assert.match(text, /\*\*Once per idea per session\.\*\*/)
    assert.match(text, /\*\*Two lines, with the spec\.\*\*/)
    assert.match(text, /\*\*Never create without a yes\.\*\*[^\n]*`creating-an-agent`/)
    assert.match(text, /\*\*Never for one-off work\.\*\*/)
    assert.match(text, /`bonez\.agent\.list\.v1`[^\n]*instead of proposing a twin/)
    assert.match(text, /no `bonez\.agent\.create\.v1`[^\n]*web builder/, "a server that cannot create agents still gets the suggestion")
    for (const example of [/nightly regression check/i, /weekly dependency audit/i, /morning digest of stale PRs/i]) assert.match(text, example)
    assert.match(text, /`0 3 \* \* \*`/, "a cron in words and as cron")
  })
})

describe("creating-an-agent", () => {
  const text = skillText("skills", "creating-an-agent")

  test("it checks tool_search for the operation, says the spec out loud and waits for a yes before it creates", () => {
    assert.match(text, /`tool_search`[\s\S]*"vendor": "bonez"/)
    assert.match(text, /only if the results show `bonez\.agent\.create\.v1`/, "an older server lacks the operation")
    assert.match(text, /wait for a yes/i)
    assert.ok(text.indexOf("## 2. Say it out loud") < text.indexOf("## 4. Create it"), "the question comes before the call")
    assert.match(text, /BEFORE you call the create operation/)
    assert.match(text, /the write gate covers `graph_write` and `rules` only/, "the skill is the guard")
  })

  test("it calls the create operation, polls the agent until ready, runs it only on request and reads the run", () => {
    for (const op of ["bonez.agent.create.v1", "bonez.agent.read.v1", "bonez.agent.run.v1", "bonez.run.read.v1", "bonez.run.list.v1", "bonez.agent.list.v1"]) assert.ok(text.includes(op), op)
    assert.match(text, /`deployment\.status`/)
    assert.match(text, /`runs_manually`/)
    assert.match(text, /Nothing asked for a test:\*\* do not run it/)
  })

  test("it teaches instructions that stand alone, with the plugins field and the scheduled-run caveat", () => {
    assert.match(text, /A scheduled run has no caller/)
    for (const heading of ["Goal:", "Check:", "Where:", "A problem is:", "Report:", "Do not:"]) assert.ok(text.includes(heading), heading)
    assert.match(text, /`plugins`: names of plugins already uploaded/)
    assert.match(text, /Never put a token, password or connection string in them/)
  })
})

describe("always-loaded guidance", () => {
  // The three lines every always-loaded surface carries. Claude Code has no such surface (a plugin cannot ship an
  // instructions file), so there its skill descriptions are the always-loaded part.
  const bullets = read("cursor", "rules", "bonez.mdc").split("\n---\n")[1].trim().split("\n")

  test("the Cursor rule is always-apply and holds the three lines", () => {
    const rule = read("cursor", "rules", "bonez.mdc")
    assert.match(frontmatter(rule), /^alwaysApply: true$/m)
    assert.match(frontmatter(rule), /^description: .+/m)
    assert.equal(bullets.length, 3)
    assert.ok(bullets.every((b) => b.startsWith("- ")))
  })

  for (const file of ["codex/AGENTS.md", "cursor/AGENTS.md"]) {
    test(`${file} carries the same three lines`, () => {
      const text = read(...file.split("/"))
      assert.ok(text.includes(`## Reach for Bonez, and suggest agents\n\n${bullets.join("\n")}\n`), `${file} lacks the proactive section, or it differs from cursor/rules/bonez.mdc`)
    })
  }

  test("the lines name the two skills, and the skills exist", () => {
    const joined = bullets.join("\n")
    for (const skill of AGENT_SKILLS) {
      assert.ok(joined.includes(`\`${skill}\``))
      assert.ok(existsSync(join(REPO, "skills", skill, "SKILL.md")))
    }
    assert.match(joined, /Never create one without a yes/)
  })
})

describe("the agent pointers in the commands", () => {
  const POINTER = "create one with the `creating-an-agent` skill."

  test("the agents command in every leg ends by pointing to creating-an-agent", () => {
    for (const file of ["commands/agents.md", "cursor/commands/bonez-agents.md", "codex/prompts/agents.md"]) {
      assert.ok(read(...file.split("/")).trimEnd().endsWith(POINTER), `${file} must end with: ${POINTER}`)
    }
  })

  test("the plugin creator's last step, in all three flows, hands over to creating-an-agent with the same sentence", () => {
    const sentence = "The next step is an agent that uses the plugin: offer to create one with the `creating-an-agent` skill (its `plugins` field takes the package name)."
    for (const file of ["commands/new-plugin.md", "cursor/commands/bonez-new-plugin.md", "codex/skills/new-plugin/SKILL.md"]) {
      assert.ok(read(...file.split("/")).includes(sentence), `${file} lacks the creating-an-agent hand-over`)
    }
  })
})
