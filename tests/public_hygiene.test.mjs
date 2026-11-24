// Tests for scripts/check-public-hygiene.mjs, the check that keeps this public repository free of internal
// references. The samples are put together at run time, so this file does not trip the check it tests.
//
// Offline. Run: node --test tests/public_hygiene.test.mjs   (or ./tests/test_public_hygiene.sh)
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { RULES, hashWord, loadAllow, scanText } from "../scripts/check-public-hygiene.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(REPO, "scripts", "check-public-hygiene.mjs")
const j = (...parts) => parts.join("")

describe("each rule catches what it is for", () => {
  const samples = {
    "tracker-id": j("fixed in 1S", "I-4145"),
    "tracker-link": j("https://linear", ".app/acme/issue/X-1"),
    "private-repo": j("see bonez", "-core for the server"),
    "internal-host": j("https://foo.sbx", ".bonez.io/mcp"),
    aws: j("arn:aws", ":iam::000000000000:role/x"),
    "backend-env": j("set BONEZ_MCP_OAUTH", "_CLIENT_ID on the server"),
    "staff-address": j("mail someone", "@bonez.io"),
    process: j("on the dev ", "tenant"),
  }
  for (const [id, matcher] of RULES) {
    if (!(matcher instanceof RegExp)) continue
    test(id, () => {
      assert.ok(samples[id], `no sample for ${id}`)
      assert.deepEqual(scanText(samples[id], "x").map((h) => h.rule), [id])
    })
  }

  // The name lists are hashed, so this file cannot spell a real one: check the mechanism with a made-up name.
  test("a hashed name is caught whole and as part of a word, in any case", () => {
    const rules = [["customer", { hashes: new Set([hashWord("examplecorp")]) }, "x"]]
    assert.deepEqual(scanText("the ExampleCorp repo", "x", [], rules).map((h) => h.match), ["ExampleCorp"])
    assert.deepEqual(scanText("examplecorp-pilot-01/ledger.py", "x", [], rules).map((h) => h.match), ["examplecorp"])
    assert.deepEqual(scanText("example corp", "x", [], rules), [])
  })

  test("the customer and staff lists hold hashes, not names", () => {
    for (const [id, matcher] of RULES.filter(([, m]) => !(m instanceof RegExp))) {
      assert.ok(matcher.hashes.size > 0, id)
      for (const h of matcher.hashes) assert.match(h, /^[0-9a-f]{16}$/, id)
    }
  })

  test("public names pass: the hosted gateway, the app, the docs, the support address, the public client id", () => {
    const text = "https://gateway.bonez.io/mcp https://app.bonez.io https://bonez.io/plugin/ support@bonez.io qFX0bzskdcDBhbJaBBwGoiLN5yWkBrMm"
    assert.deepEqual(scanText(text, "x"), [])
  })
})

describe("the allow-list", () => {
  test("an entry allows its exact text in its file only", () => {
    const allow = loadAllow(j("a.md | tracker-link | linear", ".app/ | a reason\n"))
    const text = j("https://linear", ".app/x")
    assert.deepEqual(scanText(text, "a.md", allow), [])
    assert.equal(scanText(text, "b.md", allow).length, 1)
  })

  test("an entry without a reason, or with an unknown rule, is refused", () => {
    assert.throws(() => loadAllow("a.md | customer | x\n"), /want/)
    assert.throws(() => loadAllow("a.md | nonsense | x | why\n"), /unknown rule/)
  })

  test("every entry in .public-hygiene-allow has a reason and a known rule", () => {
    const text = readFileSync(join(REPO, ".public-hygiene-allow"), "utf8")
    assert.ok(loadAllow(text).length > 0)
  })
})

describe("the command", () => {
  test("the repository is clean", () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: "utf8" })
    assert.equal(r.status, 0, r.stdout + r.stderr)
  })

  test("--text fails on a pull request title that names a ticket, and passes a clean one", () => {
    const dir = mkdtempSync(join(tmpdir(), "bonez-hygiene-"))
    writeFileSync(join(dir, "bad"), j("Fix sign-in (1S", "I-4145)"))
    writeFileSync(join(dir, "good"), "Fix sign-in")
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--text", join(dir, "bad")], { cwd: REPO }).status, 1)
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--text", join(dir, "good")], { cwd: REPO }).status, 0)
  })
})
