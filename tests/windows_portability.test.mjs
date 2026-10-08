// Windows portability guards that need no Windows to write, and catch a regression when run on one:
//
//   - every tracked text file is LF in the working tree (Git for Windows defaults to core.autocrlf=true;
//     .gitattributes is what keeps a Windows clone from turning the shell scripts into "bash\r");
//   - the hook commands are shaped so a plugin path with a space survives and no .sh is exec'd bare;
//   - bin/bonez-session-sync.mjs actually runs when started by a Windows-style or spaced path
//     (its "am I the main script" test used to compare a file:// URL with a path and was false on Windows);
//   - the project-directory slugs it derives from Windows paths.
//
// Offline and dependency-free. Run: node --test tests/windows_portability.test.mjs   (or ./tests/test_windows.sh)
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { symlinkOrSkip } from "./lib/fs-helpers.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const json = (rel) => JSON.parse(readFileSync(join(REPO, rel), "utf8"))

const roots = []
function freshDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `bonez-${prefix}-`))
  roots.push(dir)
  return dir
}
process.on("exit", () => roots.forEach((d) => rmSync(d, { recursive: true, force: true })))

// Tracked files when git is here, else a walk that skips .git (a source tarball has no .git).
function repoFiles() {
  const git = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
  if (git.status === 0 && git.stdout) return git.stdout.split("\0").filter(Boolean)
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue
      const abs = join(dir, name)
      statSync(abs).isDirectory() ? walk(abs) : out.push(relative(REPO, abs).split(sep).join("/"))
    }
  }
  walk(REPO)
  return out
}

describe("line endings", () => {
  test(".gitattributes pins LF for everything, and for the file types that break on CRLF", () => {
    const attrs = readFileSync(join(REPO, ".gitattributes"), "utf8")
    assert.match(attrs, /^\* +text=auto +eol=lf$/m)
    for (const pattern of ["*.sh", "*.mjs", "*.json", "*.md"]) {
      assert.match(attrs, new RegExp(`^${pattern.replace("*", "\\*").replace(".", "\\.")} +text +eol=lf$`, "m"), pattern)
    }
  })

  test("no tracked file has a carriage return in the working tree (on Windows CI this is the autocrlf check)", () => {
    const withCr = repoFiles().filter((f) => readFileSync(join(REPO, f)).includes(0x0d))
    assert.deepEqual(withCr, [], `CRLF in: ${withCr.slice(0, 5).join(", ")}. A shell script with CRLF fails ("bash\\r"); check .gitattributes and core.autocrlf.`)
  })
})

describe("hook commands", () => {
  const commandsOf = (file) => Object.values(json(file).hooks).flatMap((groups) => groups.flatMap((g) => (g.hooks ?? [g]).map((h) => h.command)))

  test("Claude Code: the plugin root is always quoted, so a path with a space stays one word", () => {
    const commands = commandsOf("hooks/hooks.json")
    assert.ok(commands.length >= 3)
    for (const command of commands) {
      assert.ok(command.includes("CLAUDE_PLUGIN_ROOT"), command)
      const unquoted = command.replace(/"[^"]*"/g, "") // what is left once every double-quoted span is gone
      assert.ok(!unquoted.includes("CLAUDE_PLUGIN_ROOT"), `unquoted plugin root in: ${command}`)
    }
  })

  test("Claude Code: the write gate is run through bash (Git Bash on Windows), never as a bare script", () => {
    const gate = json("hooks/hooks.json").hooks.PreToolUse[0].hooks[0].command
    assert.match(gate, /^bash "\$\{CLAUDE_PLUGIN_ROOT:-\$PLUGIN_ROOT\}\/hooks\/gate-write\.sh"$/)
  })

  test("Cursor: every hook names its interpreter (a bare .sh is opened by the Windows file association)", () => {
    const commands = commandsOf("cursor/hooks/hooks.json")
    assert.ok(commands.length >= 3)
    for (const command of commands) assert.match(command, /^bash \.\/hooks\/[a-z-]+\.sh\b/, command)
  })
})

describe("bin/bonez-session-sync.mjs", () => {
  const sandbox = () => {
    const home = freshDir("sync-home")
    return { HOME: home, USERPROFILE: home, BONEZ_SESSION_SYNC_DATA: join(home, "data"), BONEZ_SESSION_SYNC: "" }
  }
  const status = (script) => spawnSync(process.execPath, [script, "status"], { encoding: "utf8", env: { ...process.env, ...sandbox() } })

  test("runs when started from a path with a space in it (a user name with a space is common on Windows)", () => {
    const dir = join(freshDir("sync-space"), "Jane Doe", "plug in")
    mkdirSync(dir, { recursive: true })
    cpSync(join(REPO, "bin"), join(dir, "bin"), { recursive: true })
    const r = status(join(dir, "bin", "bonez-session-sync.mjs"))
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /session capture: not installed/, "main() must have run")
  })

  test("runs when started through a symlink", (t) => {
    const link = join(freshDir("sync-link"), "sync.mjs")
    if (!symlinkOrSkip(t, join(REPO, "bin", "bonez-session-sync.mjs"), link)) return
    const r = status(link)
    assert.match(r.stdout, /session capture: not installed/)
  })

  test("stays silent when imported (no main() as a side effect)", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")
    assert.equal(typeof mod.cursorProjectSlug, "function")
  })

  test("the project-directory slugs of a Windows workspace", async () => {
    const { cursorProjectSlug, claudeProjectSlug } = await import("../bin/bonez-session-sync.mjs")
    for (const root of ["c:\\Users\\me\\proj", "/c:/Users/me/proj", "c:/Users/me/proj/", "c:\\Users\\me\\proj\\"]) {
      assert.equal(cursorProjectSlug(root), "c-Users-me-proj", root)
    }
    assert.equal(claudeProjectSlug("C:\\Users\\me\\my_proj.v2"), "C--Users-me-my-proj-v2")
    assert.equal(claudeProjectSlug("C:\\Users\\me\\proj\\"), "C--Users-me-proj")
  })

  test("and a POSIX workspace keeps exactly its old slug", async () => {
    const { cursorProjectSlug, claudeProjectSlug } = await import("../bin/bonez-session-sync.mjs")
    assert.equal(cursorProjectSlug("/Users/me/proj"), "Users-me-proj")
    assert.equal(cursorProjectSlug("/Users/me/proj/"), "Users-me-proj")
    assert.equal(claudeProjectSlug("/Users/me/re_gent.headless/"), "-Users-me-re-gent-headless")
    assert.equal(claudeProjectSlug("/tmp/bonez-session-sync-fixture-repo"), "-tmp-bonez-session-sync-fixture-repo")
    assert.equal(cursorProjectSlug(""), null)
  })
})
