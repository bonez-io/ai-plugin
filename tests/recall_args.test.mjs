// What the recall hook asks the agent to send to memory_recall, on the three legs (Claude Code at the repo
// root, Codex in codex/, Cursor in cursor/).
//
// A seed call with no arguments returns the person's own memories and work in flight and nothing the team
// learned about the task: the server matches that to the task, so it needs the task. So every leg's guidance
// names the repository (read locally from the session folder's origin remote) and `message`, a placeholder the
// agent fills in with one sentence, and file guidance names `message` next to `refs`. The hook never copies the
// prompt's text into its output, and in Claude Code it reminds on a session's first prompt only.
//
// Offline and dependency-free (Node's built-in runner).
// Run: node --test tests/recall_args.test.mjs   (or ./tests/test_recall_args.sh)
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (...parts) => readFileSync(join(REPO, ...parts), "utf8")
const TASK = "<the task in one sentence>"
// The two spellings of an empty call, built here so that this file does not hold them either.
const EMPTY = "{" + "}"
const STALE = ["with " + EMPTY, "with `" + EMPTY + "`", "memory_recall(" + EMPTY + ")"]

const roots = []
process.on("exit", () => roots.forEach((d) => rmSync(d, { recursive: true, force: true })))
function freshDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `bonez-${prefix}-`))
  roots.push(dir)
  return dir
}

// A checkout of acme/api with one file, and a folder that is no checkout at all.
function makeRepo() {
  const repo = freshDir("recall-repo")
  for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/acme/api.git"]]) {
    assert.equal(spawnSync("git", args, { cwd: repo }).status, 0)
  }
  mkdirSync(join(repo, "src"))
  writeFileSync(join(repo, "src", "refund.py"), "x = 1\n")
  return repo
}

// Each leg's own copy of the hook, its event names, and how its payload names the session and its folder.
const LEGS = {
  claude: { script: ["bin"], start: "SessionStart", tool: "PostToolUse", read: "Read",
    payload: (id, dir) => ({ session_id: id, ...(dir && { cwd: dir }) }) },
  codex: { script: ["codex", "bin"], start: "SessionStart", tool: "PostToolUse", read: "apply_patch",
    payload: (id, dir) => ({ session_id: id, ...(dir && { cwd: dir }) }) },
  cursor: { script: ["cursor", "bin"], start: "sessionStart", tool: "postToolUse", read: "Read",
    payload: (id, dir) => ({ conversation_id: id, ...(dir && { workspace_roots: [dir] }) }) },
}

// Runs one leg's hook on one event, in a sandbox: its own home, capture data and plugin data, so nothing on
// this computer (a session capture already announced, an earlier run's markers) reaches the answer.
function sandbox() {
  const dir = freshDir("recall-data")
  return { data: dir, env: { HOME: dir, USERPROFILE: dir, BONEZ_SESSION_SYNC_DATA: dir, CLAUDE_PLUGIN_DATA: dir } }
}
function run(leg, event, box = sandbox()) {
  const result = spawnSync(process.execPath, [join(REPO, ...LEGS[leg].script, "bonez-recall-hook.mjs"), leg], {
    cwd: freshDir("recall-cwd"), encoding: "utf8", input: JSON.stringify(event), env: { ...process.env, ...box.env },
  })
  assert.equal(result.status, 0, result.stderr)
  if (!result.stdout) return { stdout: "", context: "" }
  const reply = JSON.parse(result.stdout)
  return { stdout: result.stdout, context: leg === "cursor" ? reply.additional_context : reply.hookSpecificOutput.additionalContext }
}
const startOf = (leg, id, dir, box) => run(leg, { hook_event_name: LEGS[leg].start, ...LEGS[leg].payload(id, dir) }, box).context
const promptOf = (id, prompt, dir, box) => run("claude", { hook_event_name: "UserPromptSubmit", session_id: id, prompt, ...(dir && { cwd: dir }) }, box)

// The arguments the context tells the agent to send, parsed: they must be a call the server accepts as written.
function seedArgs(context) {
  const found = /memory_recall with (\{[^}]*\})/.exec(context)
  assert.ok(found, `no seed call in: ${context}`)
  return JSON.parse(found[1])
}
function assertNoEmptyCall(text, where) {
  for (const stale of STALE) assert.ok(!text.includes(stale), `${where} still asks for an empty call: ${stale}`)
}

describe("the seed call names the repository and the task", () => {
  for (const leg of Object.keys(LEGS)) {
    test(`${leg}: session start asks for repo and message, never an empty call`, () => {
      const repo = makeRepo()
      const context = startOf(leg, "s-1", repo)
      assert.deepEqual(seedArgs(context), { repo: "acme/api", message: TASK })
      assertNoEmptyCall(context, leg)
      assert.match(context, /Write message yourself, as one sentence that names the task; never send empty arguments\./)
      assert.match(context, /^For standalone questions, answer directly\./)
    })

    test(`${leg}: outside a checkout the call carries the task alone`, () => {
      const context = startOf(leg, "s-1", freshDir("recall-scratch"))
      assert.deepEqual(seedArgs(context), { message: TASK })
      assert.doesNotMatch(context, /"repo"/)
      // No folder named by the host: never the hook's own working directory, which may be a checkout of the plugin.
      assert.deepEqual(seedArgs(startOf(leg, "s-1")), { message: TASK })
    })
  }

  test("a session that capture announced is named in the call; one it did not announce is left out", () => {
    const repo = makeRepo()
    const box = sandbox()
    assert.deepEqual(seedArgs(startOf("claude", "s-announced", repo, box)), { repo: "acme/api", message: TASK })
    mkdirSync(join(box.data, "presence"))
    writeFileSync(join(box.data, "presence", "s-announced.json"), JSON.stringify({ startedAt: 1 }))
    for (const leg of ["claude", "cursor"]) {
      const context = startOf(leg, "s-announced", repo, box)
      assert.deepEqual(seedArgs(context), { repo: "acme/api", message: TASK, session: "s-announced" })
      assert.match(context, /Pass "session": "s-announced" to every memory_recall call\./)
    }
    assert.deepEqual(seedArgs(promptOf("s-announced", "Fix it", repo, box).context), { repo: "acme/api", message: TASK, session: "s-announced" })
    writeFileSync(join(box.data, "presence", "s-refused.json"), JSON.stringify({ refused: true }))
    assert.deepEqual(seedArgs(startOf("claude", "s-refused", repo, box)), { repo: "acme/api", message: TASK })
  })

  test("Claude Code is never pointed at a seed that nothing adds; Codex keeps its own and is asked for the task call on top", () => {
    const repo = makeRepo()
    for (const leg of ["claude", "cursor"]) {
      const context = startOf(leg, "s-1", repo)
      assert.match(context, /once, before planning: no Bonez seed is added to this session for you\./)
      assert.doesNotMatch(context, /seed already in context/)
    }
    assert.match(startOf("codex", "s-1", repo),
      /once, as soon as the task is known\. A Bonez seed already in context was loaded before the task existed: it holds your own memories and work in flight, and this call adds what the team learned about the task\./)
    // Codex's own seed is still the one read a hook makes, with no arguments: there is no task yet when it runs.
    const seeds = JSON.parse(read("codex", "hooks", "hooks.json")).hooks.SessionStart.flatMap((g) => g.hooks).filter((h) => h.type === "mcp_tool")
    assert.deepEqual(seeds.map((h) => [h.tool, "input" in h]), [["memory_recall", false]])
  })
})

describe("Claude Code reminds on the first prompt of a session, and only then", () => {
  test("prompt 1 gets the seed call; prompt 2 gets nothing; a later prompt that names a file gets the file reminder", () => {
    const repo = makeRepo()
    const box = sandbox()
    const first = promptOf("s-1", "Make refunds idempotent", repo, box).context
    assert.deepEqual(seedArgs(first), { repo: "acme/api", message: TASK })
    assert.match(first, /^If this prompt starts engineering work that depends on project context, call memory_recall with /)
    assert.match(first, /For a standalone question, answer directly\.$/)
    assertNoEmptyCall(first, "first prompt")

    assert.equal(promptOf("s-1", "And add a test for it", repo, box).stdout, "")
    assert.equal(promptOf("s-1", "Thanks!", repo, box).stdout, "")

    const named = promptOf("s-1", "Now change src/refund.py too", repo, box).context
    assert.match(named, /memory_recall tool with refs for that file and the named symbol when known, and message for the task in one sentence\./)
    assert.doesNotMatch(named, /"message":/, "the seed call is not asked for again")

    // Another session starts over, and its first prompt may name a file as well.
    const both = promptOf("s-2", "Change src/refund.py", repo, box).context
    assert.deepEqual(seedArgs(both), { repo: "acme/api", message: TASK })
    assert.match(both, /with refs for that file/)
    assert.equal(promptOf("s-2", "Go on", repo, box).stdout, "")
  })

  test("the marker is an empty file under the plugin's data folder, named by a hash, never by the session id", () => {
    const box = sandbox()
    promptOf("session/../../escape", "Fix it", undefined, box)
    const markers = readdirSync(join(box.data, "bonez-recall"))
    assert.equal(markers.length, 1)
    assert.match(markers[0], /^[a-f0-9]{32}$/)
    assert.equal(statSync(join(box.data, "bonez-recall", markers[0])).size, 0)
    assert.ok(!existsSync(join(box.data, "escape")))
  })

  test("with no session id, or a data folder that cannot be written, no prompt is reminded: silence over a reminder on every prompt", () => {
    const repo = makeRepo()
    assert.equal(run("claude", { hook_event_name: "UserPromptSubmit", prompt: "Fix it", cwd: repo }).stdout, "")
    const box = sandbox()
    const blocked = join(box.data, "a-file")
    writeFileSync(blocked, "")
    const env = { ...box.env, CLAUDE_PLUGIN_DATA: blocked }
    for (let i = 0; i < 2; i++) assert.equal(promptOf("s-1", "Fix it", repo, { ...box, env }).stdout, "")
    // The session start still asks, so the session is not left without the guidance.
    assert.deepEqual(seedArgs(startOf("claude", "s-1", repo, { ...box, env })), { repo: "acme/api", message: TASK })
  })

  test("a session start removes markers older than three days and keeps the rest", () => {
    const box = sandbox()
    promptOf("s-old", "Fix it", undefined, box)
    const [old] = readdirSync(join(box.data, "bonez-recall"))
    const then = new Date(Date.now() - 4 * 24 * 3600_000)
    utimesSync(join(box.data, "bonez-recall", old), then, then)
    promptOf("s-new", "Fix it", undefined, box)
    startOf("claude", "s-new", undefined, box)
    const left = readdirSync(join(box.data, "bonez-recall"))
    assert.equal(left.length, 1)
    assert.notEqual(left[0], old)
    assert.equal(promptOf("s-new", "Go on", undefined, box).stdout, "", "the live session stays reminded once")
  })

  test("Codex and Cursor have no prompt reminder: their prompt events print nothing", () => {
    const repo = makeRepo()
    for (const [leg, name] of [["codex", "UserPromptSubmit"], ["cursor", "beforeSubmitPrompt"]]) {
      assert.equal(run(leg, { hook_event_name: name, prompt: "Fix the refund in src/refund.py", ...LEGS[leg].payload("s-1", repo) }).stdout, "")
    }
  })
})

describe("the prompt's text never reaches hook output", () => {
  // Words that appear nowhere in the hook's own guidance, so any of them in stdout came from the prompt.
  const WORDS = ["ZEBRAQUARTZ", "xylophone", "ledger", "billing", "7781"]
  const prompt = "ZEBRAQUARTZ rotate the xylophone key 7781 in services/billing/ledger.py before Friday"

  test("Claude Code: the first prompt, a prompt naming a file, and a later one", () => {
    const repo = makeRepo()
    const box = sandbox()
    const outputs = [promptOf("s-1", prompt, repo, box), promptOf("s-1", prompt, repo, box), promptOf("s-1", "ZEBRAQUARTZ xylophone 7781", repo, box)]
    assert.ok(outputs[0].stdout && outputs[1].stdout, "the first prompt and the file reminder both print")
    assert.equal(outputs[2].stdout, "")
    for (const { stdout } of outputs) for (const word of WORDS) assert.ok(!stdout.includes(word), `${word} leaked: ${stdout}`)
    assert.equal(seedArgs(outputs[0].context).message, TASK, "the message is a placeholder for the agent to fill in")
  })

  test("every leg: no event echoes a prompt or a tool's input", () => {
    const repo = makeRepo()
    for (const leg of Object.keys(LEGS)) {
      const { start, tool, payload } = LEGS[leg]
      const events = [
        { hook_event_name: start, prompt },
        { hook_event_name: leg === "cursor" ? "beforeSubmitPrompt" : "UserPromptSubmit", prompt },
        { hook_event_name: tool, tool_name: "Read", prompt, tool_input: { file_path: join(repo, "src", "refund.py"), content: prompt, command: prompt } },
        { hook_event_name: tool, tool_name: "Bash", tool_input: { command: prompt } },
      ]
      for (const event of events) {
        const { stdout } = run(leg, { ...event, ...payload("s-1", repo) })
        for (const word of WORDS) assert.ok(!stdout.includes(word), `${leg} ${event.hook_event_name}: ${word} leaked`)
      }
    }
  })
})

describe("file guidance names refs and message", () => {
  const patch = ["*** Begin Patch", "*** Update File: src/refund.py", "@@", "-x = 1", "+x = 2", "*** End Patch", ""].join("\n")

  for (const leg of Object.keys(LEGS)) {
    test(`${leg}: after a file tool, recall is asked for with refs and the current task`, () => {
      const repo = makeRepo()
      const { tool, read: name, payload } = LEGS[leg]
      const tool_input = name === "apply_patch" ? { command: patch } : { file_path: join(repo, "src", "refund.py") }
      // Codex resolves a patch's relative path against the event's own folder.
      const { context } = run(leg, { hook_event_name: tool, tool_name: name, tool_input, ...payload("s-1", repo), cwd: repo })
      assert.match(context, /call memory_recall with refs for its owner\/repo\/path and message, the current task in one sentence/)
      // A server from before `message` was taken with `refs` refuses the pair; the agent is told what to do then.
      assert.match(context, /\(send refs alone if the server refuses message with refs\)/)
      assert.match(context, /File ref \(data\): "acme\/api\/src\/refund\.py"$/)
      assertNoEmptyCall(context, leg)
    })
  }
})

describe("no guidance anywhere asks for an empty memory_recall", () => {
  test("no tracked file holds the old wording", () => {
    const listed = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
    assert.equal(listed.status, 0, listed.stderr)
    const files = listed.stdout.split("\0").filter((f) => f && !/\.(png|jpe?g|gif|webp|ico|zip|gz)$/i.test(f) && existsSync(join(REPO, f)))
    assert.ok(files.length > 100)
    for (const file of files) assertNoEmptyCall(read(file), file)
  })

  test("every always-loaded rule, skill and context command names repo and message on the seed call", () => {
    const seed = [
      "codex/AGENTS.md", "cursor/AGENTS.md", "cursor/rules/bonez.mdc", "cursor-directory/rules/bonez.mdc",
      "commands/context.md", "claude-directory/commands/context.md", "codex/prompts/context.md",
      "cursor/commands/bonez-context.md", "cursor-directory/commands/bonez-context.md",
    ]
    for (const file of seed) assert.match(read(file), /`memory_recall\(\{repo, message\}\)`/, file)
    const call = '`{"repo": "owner/repo", "message": "<the task in one sentence>"}`'
    const skills = ["skills", "cursor/skills", "codex/skills", "claude-directory/skills", "cursor-directory/skills"].map((d) => `${d}/session-context/SKILL.md`)
    for (const file of [...skills, "codex/AGENTS.md", "cursor/AGENTS.md"]) {
      const text = read(file)
      assert.ok(text.includes(call), `${file} lacks the seed call`)
      assert.match(text, /`message`, the current task in one sentence[^\n]*if the server refuses `message` with `refs`, send the refs alone/, file)
    }
    const hooks = JSON.parse(read("hooks", "hooks.json")).description
    assert.match(hooks, /call memory_recall once, with the repository and the task in one sentence/)
    assert.match(hooks, /on a session's first prompt, a reminder to make that memory_recall call/)
  })
})
