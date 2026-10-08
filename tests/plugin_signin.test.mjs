// Tests for the sign-in lane of bin/bonez-plugin-push.mjs: no API key, so it signs in in the browser (OAuth device
// flow, in two runs) and publishes through the server's MCP endpoint (operation bonez.plugin.publish.v1).
//
// The server is tests/lib/fake-plugin-server.mjs with `oauth` on: protected-resource metadata, the authorization
// server's metadata, the device and token endpoints, and /mcp, which runs the gateway's own upload rules. The
// "browser" is `server.signin.approve()`. Offline: every request goes to 127.0.0.1, and BONEZ_NO_BROWSER keeps the
// tool from opening a real browser. Each test has a home of its own, so nothing is read from or written to ~/.bonez.
//
// Run: node --test tests/plugin_signin.test.mjs
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CliError } from "../bin/lib/net.mjs"
import { accessToken, clock } from "../bin/lib/signin.mjs"
import { startFakePluginServer } from "./lib/fake-plugin-server.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PUSH = join(HERE, "..", "bin", "bonez-plugin-push.mjs")
const CLIENT_ID = "qFX0bzskdcDBhbJaBBwGoiLN5yWkBrMm"
const KEY = "bnz_" + "ab".repeat(24)

const roots = []
const freshDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "bonez-signin-"))
  roots.push(dir)
  return dir
}
process.on("exit", () => roots.forEach((d) => rmSync(d, { recursive: true, force: true })))

const put = (root, rel, content) => {
  const abs = join(root, ...rel.split("/"))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}
function plugin(extra = {}) {
  const root = freshDir()
  put(root, "package.json", '{"name":"@example/pi-hello","version":"1.2.0","exports":{".":"./dist/index.js"}}')
  put(root, "dist/index.js", "export default function () {}\n")
  for (const [rel, content] of Object.entries(extra)) put(root, rel, content)
  return root
}

// Runs the tool the way a coding agent's shell does: to the end, output captured. No API key unless `env` has one.
function cli(args, server, home, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [PUSH, ...args], {
      env: { ...process.env, BONEZ_URL: server.url, BONEZ_API_KEY: "", BONEZ_CLIENT_ID: "", BONEZ_ALLOW_HTTP: "", BONEZ_NO_BROWSER: "1", HOME: home, USERPROFILE: home, ...env },
      encoding: "utf8", timeout: 30_000, // a run that waits for an approval nobody gives is a failed test, not a hung one
    }, (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }))
  })
}

const loginFile = (home) => join(home, ".bonez", "plugin-login.json")
const saved = (home) => JSON.parse(readFileSync(loginFile(home), "utf8"))
const mcpCalls = (server) => server.requests.filter((r) => r.url === "/mcp")
const grants = (server) => server.signin.calls.token.map((t) => t.grant_type)
const DEVICE = "urn:ietf:params:oauth:grant-type:device_code"

// Nothing a server issued (a token, a refresh token, a device code) may reach a terminal.
function noSecrets(server, ...results) {
  assert.ok(server.signin.secrets.length > 0)
  for (const r of results) {
    for (const secret of server.signin.secrets) {
      assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), `a secret was printed:\n${r.stdout}\n${r.stderr}`.replaceAll(secret, "<secret>"))
    }
  }
}

// A server, a plugin folder and a home, and the two runs of a first publish.
async function setup(oauth = {}) {
  const server = await startFakePluginServer({ key: KEY, oauth })
  return { server, home: freshDir(), dir: plugin() }
}
const finish = async (server, fn) => {
  try {
    await fn()
  } finally {
    await server.close()
  }
}

describe("the first publish: sign in in two runs", () => {
  test("run one prints the address and the code and exits 4 at once; run two finishes the sign-in and publishes", async () => {
    const { server, home, dir } = await setup()
    await finish(server, async () => {
      const one = await cli([dir], server, home)
      assert.equal(one.status, 4, one.stderr)
      assert.equal(one.stdout, `sign in at: ${server.url}/activate?user_code=WXYZ-1001\ncode: WXYZ-1001\n`)
      assert.match(one.stderr, /waiting for you to approve the sign-in/)
      assert.equal(mcpCalls(server).length, 0, "nothing was published before the sign-in")
      // The public Bonez CLI app, the scopes the publish needs, and the audience the server named.
      assert.deepEqual(server.signin.calls.device, [{ client_id: CLIENT_ID, scope: "bonez:read bonez:write offline_access", audience: `${server.url}/mcp` }])
      const pending = saved(home)[server.url]
      assert.ok(pending.pending.device_code && !pending.access_token, "the pending flow is saved, with no token yet")
      if (process.platform !== "win32") assert.equal(statSync(loginFile(home)).mode & 0o777, 0o600)

      server.signin.approve()
      const two = await cli([dir], server, home)
      assert.equal(two.status, 0, two.stderr)
      assert.match(two.stdout, /^pushed @example\/pi-hello 1\.2\.0\nfingerprint: [0-9a-f]{64}\nrolling out to 2 computers\n$/)
      assert.deepEqual(mcpCalls(server).map((r) => r.rpc), ["initialize", "notifications/initialized", "tools/call"])
      assert.ok(mcpCalls(server).every((r) => /text\/event-stream/.test(r.accept) && /application\/json/.test(r.accept)))
      assert.equal(mcpCalls(server).at(-1).protocol, "2025-06-18")
      const call = mcpCalls(server).at(-1)
      assert.equal(call.outcome, "ok")
      assert.equal(call.claimed, call.recomputed, "the hash the CLI sent is the one the server recomputed")
      assert.match(two.stdout, new RegExp(`fingerprint: ${call.recomputed}`))
      const entry = saved(home)[server.url]
      assert.ok(entry.access_token && entry.refresh_token && entry.expires_at > Date.now() && !entry.pending)
      assert.equal(entry.scope, "bonez:read bonez:write offline_access")
      noSecrets(server, one, two)
    })
  })

  test("a run that comes while the browser has not approved yet keeps polling and finishes when it does", async () => {
    const { server, home, dir } = await setup()
    await finish(server, async () => {
      assert.equal((await cli([dir], server, home)).status, 4)
      const second = cli([dir], server, home)
      await new Promise((resolve) => setTimeout(resolve, 400))
      server.signin.approve()
      const two = await second
      assert.equal(two.status, 0, two.stderr)
      assert.ok(grants(server).filter((g) => g === DEVICE).length > 1, "it polled more than once")
    })
  })

  test("the address and code are plain lines on stdout, and the browser is asked to open the address", async (t) => {
    if (process.platform === "win32") return t.skip("the opener here is a POSIX script; rundll32 is not stubbed")
    const { server, home, dir } = await setup()
    await finish(server, async () => {
      // `open` (macOS) and `xdg-open` (Linux) are stubs that record what they were given.
      const bin = freshDir()
      const record = join(bin, "opened")
      for (const name of ["open", "xdg-open"]) {
        writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" > "${record}"\n`)
        chmodSync(join(bin, name), 0o755)
      }
      const r = await cli([dir], server, home, { BONEZ_NO_BROWSER: "", PATH: `${bin}${delimiter}${process.env.PATH}` })
      assert.equal(r.status, 4, r.stderr)
      for (let i = 0; i < 40 && !existsSync(record); i++) await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(readFileSync(record, "utf8").trim(), `${server.url}/activate?user_code=WXYZ-1001`)
    })
  })

  test("a browser that cannot be opened never fails the run", async (t) => {
    if (process.platform === "win32") return t.skip("Windows finds rundll32 whatever PATH says")
    const { server, home, dir } = await setup()
    await finish(server, async () => {
      const r = await cli([dir], server, home, { BONEZ_NO_BROWSER: "", PATH: freshDir() })
      assert.equal(r.status, 4, r.stderr)
      assert.match(r.stdout, /^sign in at: .+\ncode: WXYZ-1001\n$/)
    })
  })

  test("a folder that cannot be published is refused before any sign-in starts", async () => {
    const { server, home } = await setup()
    await finish(server, async () => {
      const r = await cli([join(home, "nope")], server, home)
      assert.equal(r.status, 2)
      assert.equal(server.requests.length, 0)
    })
  })

  test("denied: exit 4 with one line, the pending flow is gone; the next run starts a new sign-in", async () => {
    const { server, home, dir } = await setup()
    await finish(server, async () => {
      await cli([dir], server, home)
      server.signin.deny()
      const two = await cli([dir], server, home)
      assert.equal(two.status, 4)
      assert.equal(two.stdout, "")
      assert.equal(two.stderr.trim().split("\n").length, 1, two.stderr)
      assert.match(two.stderr, /denied/)
      assert.equal(saved(home)[server.url].pending, undefined)
      const three = await cli([dir], server, home)
      assert.equal(three.status, 4)
      assert.match(three.stdout, /code: WXYZ-1002/)
      server.signin.approve()
      assert.equal((await cli([dir], server, home)).status, 0)
    })
  })

  test("expired: exit 4 with one line, and the next run starts a new sign-in", async () => {
    const { server, home, dir } = await setup()
    await finish(server, async () => {
      await cli([dir], server, home)
      server.signin.expire()
      const two = await cli([dir], server, home)
      assert.equal(two.status, 4)
      assert.equal(two.stdout, "")
      assert.equal(two.stderr.trim().split("\n").length, 1, two.stderr)
      assert.match(two.stderr, /expired/)
      assert.equal(saved(home)[server.url].pending, undefined)
      assert.match((await cli([dir], server, home)).stdout, /code: WXYZ-1002/)
    })
  })

  test("authorization endpoints found under openid-configuration work too", async () => {
    const { server, home, dir } = await setup({ metadataAt: "openid-configuration" })
    await finish(server, async () => {
      await cli([dir], server, home)
      server.signin.approve()
      assert.equal((await cli([dir], server, home)).status, 0)
    })
  })

  test("a server that streams its answers and keeps a session is read too, and the session id is sent back", async () => {
    const { server, home, dir } = await setup({ mcp: "sse", session: true })
    await finish(server, async () => {
      await cli([dir], server, home)
      server.signin.approve()
      const r = await cli([dir], server, home)
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /^pushed @example\/pi-hello 1\.2\.0\n/)
      assert.deepEqual(mcpCalls(server).map((c) => c.session), [null, "fake-session-1", "fake-session-1"])
    })
  })
})

describe("a saved sign-in", () => {
  async function signedIn(oauth) {
    const s = await setup(oauth)
    await cli([s.dir], s.server, s.home)
    s.server.signin.approve()
    const r = await cli([s.dir], s.server, s.home)
    assert.equal(r.status, 0, r.stderr)
    return s
  }

  test("is reused: the next publish makes no sign-in request at all", async () => {
    const { server, home, dir } = await signedIn()
    await finish(server, async () => {
      const before = grants(server).length
      const r = await cli([dir], server, home)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(grants(server).length, before, "no token request")
      assert.equal(server.signin.calls.device.length, 1)
      assert.equal(mcpCalls(server).filter((c) => c.rpc === "tools/call").length, 2)
      assert.equal(mcpCalls(server).filter((c) => c.outcome === "unauthenticated").length, 0)
    })
  })

  test("is refreshed before it runs out", async () => {
    const { server, home, dir } = await signedIn({ accessTtl: 30 }) // inside the minute the tool keeps in hand
    await finish(server, async () => {
      const r = await cli([dir], server, home)
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(grants(server), [DEVICE, "refresh_token"])
      assert.equal(mcpCalls(server).filter((c) => c.outcome === "unauthenticated").length, 0, "the old token was never tried")
    })
  })

  test("a 401 refreshes once and tries again", async () => {
    const { server, home, dir } = await signedIn()
    await finish(server, async () => {
      server.signin.invalidateAccess()
      const r = await cli([dir], server, home)
      assert.equal(r.status, 0, r.stderr)
      assert.deepEqual(grants(server).slice(-1), ["refresh_token"])
      assert.equal(mcpCalls(server).filter((c) => c.outcome === "unauthenticated").length, 1)
      noSecrets(server, r)
    })
  })

  test("with a rotating refresh token, the new one is kept (the old one is dead)", async () => {
    const { server, home, dir } = await signedIn({ rotate: true })
    await finish(server, async () => {
      for (let i = 0; i < 2; i++) {
        server.signin.invalidateAccess()
        const r = await cli([dir], server, home)
        assert.equal(r.status, 0, `refresh ${i + 1}: ${r.stderr}`)
      }
      assert.deepEqual(grants(server).filter((g) => g === "refresh_token").length, 2)
    })
  })

  test("a refused refresh starts the sign-in again: a new code, exit 4", async () => {
    const { server, home, dir } = await signedIn()
    await finish(server, async () => {
      server.signin.invalidateAccess()
      server.signin.revokeRefresh()
      const r = await cli([dir], server, home)
      assert.equal(r.status, 4, r.stderr)
      assert.match(r.stdout, /code: WXYZ-1002/)
      assert.equal(saved(home)[server.url].access_token, undefined, "the dead tokens are dropped")
      server.signin.approve()
      assert.equal((await cli([dir], server, home)).status, 0)
    })
  })

  test("granted less than the publish needs: the server's scope challenge starts a new sign-in", async () => {
    const { server, home, dir } = await setup({ grant: ["bonez:read", "offline_access"] })
    await finish(server, async () => {
      await cli([dir], server, home)
      server.signin.approve()
      const refused = await cli([dir], server, home)
      assert.equal(refused.status, 4, refused.stderr)
      assert.match(refused.stdout, /code: WXYZ-1002/)
      assert.equal(server.signin.calls.device.length, 2)
      assert.ok(server.signin.calls.device[1].scope.split(" ").includes("bonez:write"))
      server.signin.grant("bonez:read", "bonez:write", "offline_access")
      assert.equal((await cli([dir], server, home)).status, 0)
    })
  })

  test("--login with a sign-in says so and asks for nothing; --logout forgets it", async () => {
    const { server, home } = await signedIn()
    await finish(server, async () => {
      const before = server.requests.length
      const login = await cli(["--login"], server, home)
      assert.equal(login.status, 0, login.stderr)
      assert.equal(login.stdout, `signed in to ${server.url}\n`)
      assert.equal(server.requests.length, before, "no request")
      const out = await cli(["--logout"], server, home)
      assert.equal(out.stdout, `signed out of ${server.url}\n`)
      assert.equal(existsSync(loginFile(home)), false, "the file goes with its last sign-in")
      assert.equal((await cli(["--logout"], server, home)).stdout, `not signed in to ${server.url}\n`)
    })
  })

  test("--logout forgets one server and keeps the others", async () => {
    const a = await setup()
    const b = await startFakePluginServer({ oauth: {} })
    await finish(b, async () => {
      await finish(a.server, async () => {
        for (const server of [a.server, b]) {
          await cli(["--login"], server, a.home)
          server.signin.approve()
          assert.equal((await cli(["--login"], server, a.home)).status, 0)
        }
        assert.deepEqual(Object.keys(saved(a.home)).sort(), [a.server.url, b.url].sort())
        await cli(["--logout"], a.server, a.home)
        assert.deepEqual(Object.keys(saved(a.home)), [b.url])
      })
    })
  })
})

describe("--login", () => {
  test("starts a sign-in even when a key is set, prints the address and code, and exits 4", async () => {
    const { server, home } = await setup()
    await finish(server, async () => {
      const r = await cli(["--login"], server, home, { BONEZ_API_KEY: KEY })
      assert.equal(r.status, 4, r.stderr)
      assert.match(r.stdout, /^sign in at: .+\ncode: WXYZ-1001\n$/)
      assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY))
      server.signin.approve()
      const done = await cli(["--login"], server, home)
      assert.equal(done.status, 0, done.stderr)
      assert.equal(done.stdout, `signed in to ${server.url}\n`)
    })
  })

  test("a pending sign-in is finished by --login, and a denied one is cleared in one line", async () => {
    const { server, home } = await setup()
    await finish(server, async () => {
      await cli(["--login"], server, home)
      server.signin.deny()
      const r = await cli(["--login"], server, home)
      assert.equal(r.status, 4)
      assert.equal(r.stderr.trim().split("\n").length, 1)
    })
  })
})

describe("the credential order", () => {
  test("BONEZ_API_KEY first: the console's upload route, with no sign-in lookup, even when a sign-in is saved", async () => {
    const { server, home, dir } = await setup()
    await finish(server, async () => {
      await cli([dir], server, home) // a pending sign-in is saved
      server.signin.approve()
      assert.equal((await cli([dir], server, home)).status, 0) // and a finished one
      const before = server.requests.length
      const r = await cli([dir], server, home, { BONEZ_API_KEY: KEY })
      assert.equal(r.status, 0, r.stderr)
      const since = server.requests.slice(before)
      assert.deepEqual(since.map((q) => `${q.method} ${q.url}`), ["POST /api/admin/org/plugins"])
      assert.equal(since[0].auth, `Bearer ${KEY}`)
    })
  })

  test("a key is never quietly replaced by a sign-in: a wrong key is the server's refusal, exit 1", async () => {
    const { server, home, dir } = await setup()
    await finish(server, async () => {
      const r = await cli([dir], server, home, { BONEZ_API_KEY: "bnz_" + "cd".repeat(24) })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /unauthenticated/)
      assert.equal(server.requests.some((q) => q.url.startsWith("/.well-known") || q.url === "/mcp"), false)
    })
  })

  test("without a key and without a saved sign-in, it signs in (the key is optional)", async () => {
    const { server, home, dir } = await setup()
    await finish(server, async () => {
      const r = await cli([dir], server, home)
      assert.equal(r.status, 4)
      assert.equal(server.requests[0].url, "/.well-known/oauth-protected-resource/mcp")
    })
  })

  test("--status needs a key for now, and says so without starting a sign-in", async () => {
    const { server, home } = await setup()
    await finish(server, async () => {
      const r = await cli(["--status"], server, home)
      assert.equal(r.status, 2)
      assert.match(r.stderr, /--status needs BONEZ_API_KEY for now/)
      assert.equal(server.requests.length, 0)
      const keyed = await cli(["--status"], server, home, { BONEZ_API_KEY: KEY })
      assert.equal(keyed.status, 0, keyed.stderr)
    })
  })
})

describe("what the server says", () => {
  async function publishedAs(oauth) {
    const s = await setup(oauth)
    await cli([s.dir], s.server, s.home)
    s.server.signin.approve()
    return { ...s, run: () => cli([s.dir], s.server, s.home) }
  }

  test("an account that is not an admin gets one line saying so, exit 1 (either way the server tells it)", async () => {
    for (const adminRefusal of ["error", "failed"]) {
      const { server, run } = await publishedAs({ admin: false, adminRefusal })
      await finish(server, async () => {
        const r = await run()
        assert.equal(r.status, 1, r.stderr)
        assert.equal(r.stdout, "")
        assert.match(r.stderr, /bonez-plugin-push: your account is not an admin of this Bonez server\n$/, adminRefusal)
        assert.doesNotMatch(r.stderr, /refused \(/)
      })
    }
  })

  test("the server's vetting refusal is shown with its code and detail, exit 1", async () => {
    const { server, home } = await setup()
    await finish(server, async () => {
      const dir = plugin({ "README.md": "x" })
      await cli([dir], server, home)
      server.signin.approve()
      const r = await cli([dir], server, home)
      assert.equal(r.status, 1)
      assert.ok(r.stderr.includes("refused (plugin_invalid: README.md: only package.json and files under dist/"), r.stderr)
    })
  })

  test("a server that has no such operation says it may predate publishing, and points to the key", async () => {
    const { server, home, dir } = await setup({ noPublish: true })
    await finish(server, async () => {
      await cli([dir], server, home)
      server.signin.approve()
      const r = await cli([dir], server, home)
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /refused \(operation_not_found: unknown vendor operation\)/)
      assert.match(r.stderr, /may predate it/)
      assert.match(r.stderr, /BONEZ_API_KEY/)
    })
  })

  test("a server that repeats the token back in a refusal does not get it printed", async () => {
    const { server, home, dir } = await setup({ echoToken: true })
    await finish(server, async () => {
      await cli([dir], server, home)
      server.signin.approve()
      const r = await cli([dir], server, home)
      assert.equal(r.status, 1)
      assert.match(r.stderr, /rejected \[token\] as given/)
      noSecrets(server, r)
    })
  })

  test("a server that offers no sign-in says so and points to the key, exit 3", async () => {
    const server = await startFakePluginServer({ key: KEY })
    await finish(server, async () => {
      const r = await cli([plugin()], server, freshDir())
      assert.equal(r.status, 3)
      assert.match(r.stderr, /does not say how to sign in/)
      assert.match(r.stderr, /BONEZ_API_KEY/)
    })
  })

  test("an unreachable server is exit 3 and the message names the address it tried", async () => {
    const probe = createServer()
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const { port } = probe.address()
    await new Promise((resolve) => probe.close(resolve))
    const r = await cli([plugin()], { url: `http://127.0.0.1:${port}` }, freshDir())
    assert.equal(r.status, 3)
    assert.ok(r.stderr.includes(`cannot reach http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp: ECONNREFUSED`), r.stderr)
    assert.match(r.stderr, /check BONEZ_URL/)
  })
})

describe("where the sign-in is saved", () => {
  test("under the home directory the operating system names (HOME, or USERPROFILE on Windows), also with a space in it", async () => {
    const { server, dir } = await setup()
    await finish(server, async () => {
      const home = join(freshDir(), "Jane Doe", "C Users") // a Windows user name with a space is common
      mkdirSync(home, { recursive: true })
      const r = await cli([dir], server, home)
      assert.equal(r.status, 4, r.stderr)
      assert.ok(existsSync(join(home, ".bonez", "plugin-login.json")), "saved at <home>/.bonez/plugin-login.json")
      assert.deepEqual(Object.keys(saved(home)), [server.url], "keyed by the server's origin")
      // /mcp and a trailing slash name the same server
      server.signin.approve()
      assert.equal((await cli([dir], { url: `${server.url}/mcp/` }, home)).status, 0)
      assert.deepEqual(Object.keys(saved(home)), [server.url])
    })
  })

  test("a sign-in file that cannot be read is treated as empty, not as a crash", async () => {
    const { server, home, dir } = await setup()
    await finish(server, async () => {
      mkdirSync(join(home, ".bonez"), { recursive: true })
      writeFileSync(loginFile(home), "{ not json")
      assert.equal((await cli([dir], server, home)).status, 4)
      assert.ok(saved(home)[server.url].pending)
    })
  })

  test("nothing about the sign-in leaves the machine except to the server and its authorization server", async () => {
    const { server, home, dir } = await setup()
    await finish(server, async () => {
      await cli([dir], server, home)
      server.signin.approve()
      await cli([dir], server, home)
      const paths = new Set(server.requests.map((q) => q.url.split("?")[0]))
      assert.deepEqual([...paths].sort(), ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/mcp", "/oauth/device/code", "/oauth/token"])
    })
  })
})

// The polling loop itself, in this process, with the clock in the test's hands: what a real run would spend minutes on.
describe("the polling loop (a driven clock)", () => {
  async function inProcess(oauth, fn) {
    const server = await startFakePluginServer({ oauth })
    const home = freshDir()
    const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, BONEZ_NO_BROWSER: process.env.BONEZ_NO_BROWSER }
    const real = { ...clock }
    const log = console.log
    const lines = []
    Object.assign(process.env, { HOME: home, USERPROFILE: home, BONEZ_NO_BROWSER: "1" })
    console.log = (line) => lines.push(line)
    try {
      await fn({ server, home, lines })
    } finally {
      console.log = log
      Object.assign(clock, real)
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v)
      await server.close()
    }
  }
  const exits4 = (promise) => assert.rejects(promise, (err) => err instanceof CliError && err.code === 4)
  const virtual = () => {
    let t = Date.now()
    const sleeps = []
    Object.assign(clock, { now: () => t, sleep: async (ms) => { t += ms; sleeps.push(ms) } })
    return { sleeps, advance: (ms) => { t += ms } }
  }

  test("slow_down makes it wait five seconds longer from then on; pending does not", async () => {
    await inProcess({}, async ({ server }) => {
      await exits4(accessToken(server.url, "/mcp"))
      const { sleeps } = virtual()
      server.signin.script("authorization_pending", "slow_down", "authorization_pending", "ok")
      const token = await accessToken(server.url, "/mcp")
      assert.match(token, /^at-/)
      assert.deepEqual(sleeps.map(Math.round), [50, 5050, 5050])
    })
  })

  test("after five minutes of waiting it prints the address and code again, exits 4 and keeps the flow", async () => {
    await inProcess({ interval: 5 }, async ({ server, home, lines }) => {
      await exits4(accessToken(server.url, "/mcp"))
      lines.length = 0
      const { sleeps } = virtual()
      await assert.rejects(accessToken(server.url, "/mcp"), (err) => err.code === 4 && /still waiting/.test(err.message))
      const total = sleeps.reduce((a, b) => a + b, 0)
      assert.ok(total <= 5 * 60_000 && total > 4 * 60_000, `waited ${total} ms`)
      assert.deepEqual(lines, [`sign in at: ${server.url}/activate?user_code=WXYZ-1001`, "code: WXYZ-1001"])
      assert.ok(JSON.parse(readFileSync(join(home, ".bonez", "plugin-login.json"), "utf8"))[server.url].pending, "still pending")
      assert.equal(server.signin.calls.device.length, 1, "no second flow")
    })
  })

  test("a pending flow whose code has run out is dropped without asking the server, and a new one starts", async () => {
    await inProcess({}, async ({ server, lines }) => {
      await exits4(accessToken(server.url, "/mcp"))
      const { advance } = virtual()
      advance(20 * 60_000) // the code lives 15 minutes
      lines.length = 0
      await exits4(accessToken(server.url, "/mcp"))
      assert.deepEqual(server.signin.calls.token, [], "the old code was never tried")
      assert.equal(lines[1], "code: WXYZ-1002")
    })
  })
})
