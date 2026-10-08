// End-to-end smoke test of bin/bonez-plugin-push.mjs against a fake gateway on 127.0.0.1.
//
//     node tests/lib/push-smoke.mjs [folder]
//
// With no argument it pushes the shared "ordering" vector (tests/fixtures/plugin-tree.json) written to a
// temp folder, so the fingerprint it must print is known in advance. It does so with an API key, and then
// without one: the sign-in (a fake device flow on the same fake gateway, the home directory a temp folder
// named by HOME and USERPROFILE, which is where Windows keeps it) in two runs. It prints one PASS/FAIL line
// per check and exits 0 only when every check passed. Used by CI and by the Windows client checks script
// (tests/windows-client-checks.ps1). Its only network traffic is to 127.0.0.1.
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { startFakePluginServer } from "./fake-plugin-server.mjs"
import { VECTORS, materialize } from "./vectors.mjs"

const PUSH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "bonez-plugin-push.mjs")
const KEY = "bnz_" + "ab".repeat(24)

let failed = 0
const check = (ok, what, evidence = "") => {
  if (!ok) failed++
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${ok || !evidence ? "" : `\n     ${String(evidence).replace(/\n/g, "\n     ")}`}`)
}

const run = (url, key, folder, env = {}) =>
  new Promise((resolve) =>
    execFile(process.execPath, [PUSH, folder], { env: { ...process.env, BONEZ_URL: url, BONEZ_API_KEY: key, ...env }, encoding: "utf8", timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr })))

const tmp = mkdtempSync(join(tmpdir(), "bonez-push-smoke-"))
const server = await startFakePluginServer({ key: KEY, computers: 2 })
try {
  const vector = VECTORS.find((v) => v.name === "ordering")
  const folder = process.argv[2] ?? materialize(vector, join(tmp, "pkg"))
  const expected = process.argv[2] ? null : vector.tree_sha256

  const ok = await run(server.url, KEY, folder)
  check(ok.status === 0, "push exits 0", `exit ${ok.status}\nstdout: ${ok.stdout}\nstderr: ${ok.stderr}`)
  check(/^pushed \S+ \S+$/m.test(ok.stdout), "prints 'pushed <name> <version>'", ok.stdout)
  const printed = /^fingerprint: ([0-9a-f]{64})$/m.exec(ok.stdout)?.[1]
  check(printed !== undefined, "prints the fingerprint", ok.stdout)
  check(/^rolling out to 2 computers$/m.test(ok.stdout), "prints 'rolling out to 2 computers'", ok.stdout)
  check(!ok.stdout.includes(KEY) && !ok.stderr.includes(KEY), "never prints the key")

  const seen = server.requests[0]
  check(server.requests.length === 1 && seen?.outcome === "ok", "the fake gateway accepted exactly one upload", JSON.stringify(server.requests))
  check(seen?.auth === `Bearer ${KEY}`, "sent the bearer key")
  check(seen?.paths.length > 0 && seen.paths.every((p) => !p.includes("\\")), "every upload key uses forward slashes", seen?.paths.join(", "))
  check(seen?.claimed === seen?.recomputed, "the hash the CLI sent equals the one the gateway recomputed", `${seen?.claimed} vs ${seen?.recomputed}`)
  check(printed === seen?.recomputed, "the printed fingerprint is the gateway's", `${printed} vs ${seen?.recomputed}`)
  if (expected) {
    check(printed === expected, "the fingerprint equals the shared vector's tree_sha256", `${printed} vs ${expected}`)
    check(
      JSON.stringify([...seen.paths].sort()) === JSON.stringify(Object.keys(vector.files).sort()),
      "the uploaded paths are the vector's paths",
      seen.paths.join(", "),
    )
  }

  const refused = await run(server.url, "bnz_" + "cd".repeat(24), folder)
  check(refused.status === 1 && /unauthenticated/.test(refused.stderr), "a wrong key is refused by the server: exit 1 with its code", `exit ${refused.status}\n${refused.stderr}`)

  // No key: sign in. The first run prints the address and the code and exits 4; once approved, the second run publishes.
  const home = join(tmp, "Home Dir")
  mkdirSync(home, { recursive: true })
  const signIn = await startFakePluginServer({ oauth: {}, computers: 2 })
  try {
    const env = { BONEZ_NO_BROWSER: "1", BONEZ_CLIENT_ID: "", HOME: home, USERPROFILE: home }
    const one = await run(signIn.url, "", folder, env)
    check(one.status === 4 && /^sign in at: \S+\ncode: \S+\n$/.test(one.stdout), "no key: the first run prints the address and the code, and exits 4", `exit ${one.status}\nstdout: ${one.stdout}\nstderr: ${one.stderr}`)
    signIn.signin.approve()
    const two = await run(signIn.url, "", folder, env)
    check(two.status === 0, "once approved, the second run publishes: exit 0", `exit ${two.status}\nstdout: ${two.stdout}\nstderr: ${two.stderr}`)
    check(/^rolling out to 2 computers$/m.test(two.stdout) && (!expected || two.stdout.includes(expected)), "and prints the same result lines", two.stdout)
    const file = join(home, ".bonez", "plugin-login.json")
    check(existsSync(file) && readFileSync(file, "utf8").includes('"access_token"'), "the sign-in is saved under the home directory (HOME / USERPROFILE)", file)
    const tool = signIn.requests.filter((q) => q.url === "/mcp" && q.rpc === "tools/call")
    check(tool.length === 1 && tool[0].outcome === "ok" && tool[0].claimed === tool[0].recomputed, "the server's publish operation accepted exactly one upload with the right hash", JSON.stringify(tool))
    check(signIn.signin.secrets.every((secret) => ![one, two].some((r) => r.stdout.includes(secret) || r.stderr.includes(secret))), "never prints a token")
  } finally {
    await signIn.close()
  }
} finally {
  await server.close()
  rmSync(tmp, { recursive: true, force: true })
}
console.log(failed === 0 ? "push-smoke: PASS" : `push-smoke: FAIL (${failed} check${failed === 1 ? "" : "s"})`)
process.exit(failed === 0 ? 0 : 1)
