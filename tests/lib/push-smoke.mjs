// End-to-end smoke test of bin/bonez-plugin-push.mjs against a fake gateway on 127.0.0.1.
//
//     node tests/lib/push-smoke.mjs [folder]
//
// With no argument it pushes the shared "ordering" vector (tests/fixtures/plugin-tree.json) written to a
// temp folder, so the fingerprint it must print is known in advance. It prints one PASS/FAIL line per
// check and exits 0 only when every check passed. Used by CI and by the Windows client checks script
// (tests/windows-client-checks.ps1). Its only network traffic is to 127.0.0.1.
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
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

const run = (url, key, folder) =>
  new Promise((resolve) =>
    execFile(process.execPath, [PUSH, folder], { env: { ...process.env, BONEZ_URL: url, BONEZ_API_KEY: key }, encoding: "utf8" }, (err, stdout, stderr) =>
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
} finally {
  await server.close()
  rmSync(tmp, { recursive: true, force: true })
}
console.log(failed === 0 ? "push-smoke: PASS" : `push-smoke: FAIL (${failed} check${failed === 1 ? "" : "s"})`)
process.exit(failed === 0 ? 0 : 1)
