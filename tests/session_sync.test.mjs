// Tests for bin/bonez-session-sync.mjs.
//
// Real end-to-end (mint a sessions-scoped key against the deployed gateway) is NOT available
// here — the gateway change (1SI-1019) is merged but not yet deployed, and minting a
// sessions-scoped key needs console admin access this environment doesn't have. So these tests
// run the REAL uploader (real parsing, real scrubbing, real gzip/NDJSON framing, real HTTP
// calls) against a local stub gateway (tests/lib/stub-gateway.mjs) that asserts on the exact
// presign → PUT → complete sequence, headers, and bundle bytes — plus a run against a genuine
// transcript copied from ~/.claude/projects/ with a planted secret, and hook-side wall-time
// measurements. See the PR body for the manual E2E steps to run once the gateway is live.
//
// Run: node --test tests/session_sync.test.mjs   (or ./tests/test_session_sync.sh)
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync, cpSync, rmSync, existsSync, symlinkSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { createServer } from "node:net"

import { startStubGateway } from "./lib/stub-gateway.mjs"
import { startStubOAuth } from "./lib/stub-oauth.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, "..")
const SCRIPT = join(REPO_ROOT, "bin", "bonez-session-sync.mjs")
const TEST_KEY = "bnz_sessions_test_0123456789abcdef"

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), `bonez-session-sync-${prefix}-`))
}

// The transcripts need a token-shaped secret for the scrubber to mask, and Anthropic's plugin
// directory refuses a plugin that ships one in any file, a fake one in a test fixture included
// (1SI-3619). So tests/fixtures/*.jsonl hold a placeholder, the secrets are put together here, and
// the tests read a copy of the fixtures with the placeholders filled in. Never write one of these
// out as a single literal: that is the string the directory's scan matches.
const FAKE_GITHUB_TOKEN = ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_")
const FAKE_API_KEY = ["sk", "live", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("_")
const FIXTURES = freshDir("fixtures")
for (const name of readdirSync(join(HERE, "fixtures")).filter((n) => n.endsWith(".jsonl"))) {
  const text = readFileSync(join(HERE, "fixtures", name), "utf8")
  writeFileSync(join(FIXTURES, name), text.replaceAll("{{FAKE_GITHUB_TOKEN}}", FAKE_GITHUB_TOKEN).replaceAll("{{FAKE_API_KEY}}", FAKE_API_KEY))
}

// MUST be non-blocking (spawn, not spawnSync): the stub gateway in this file's `before()` runs
// an HTTP server IN THIS SAME PROCESS. spawnSync freezes this process's event loop until the
// child exits — including the libuv turns the gateway's http.Server needs to accept and answer
// the child's own requests — which deadlocks any test where the spawned CLI talks HTTP back to
// it (everything under `_upload`). `hook`'s own tests happened to survive spawnSync because the
// process it blocks on returns immediately without ever making an HTTP call itself — the actual
// upload happens in a further-detached grandchild this process was never watching — but async
// spawn here removes the trap for every case uniformly instead of relying on that distinction.
// Every spawned CLI gets a SANDBOX HOME unless the test names its own.
//
// This is not belt-and-braces. The credential store resolves against ~ — it prefers
// ~/.bonez/session-sync and falls back to scanning ~/.claude/plugins/data/bonez* — so a child
// inheriting the real HOME can read, and WRITE, the developer's actual credential. That is not
// hypothetical: an earlier revision of the store migration did exactly that during a test run
// on this machine, copying a real store to the canonical path and then overwriting its config
// with the test key. Pinning HOME here makes the whole class impossible.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "bonez-session-sync-home-"))

function runCli(args, { env = {}, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      // The catch-up's quiet period would hold back the transcripts these tests just wrote. The
      // in-process check below runs with the real ten minutes.
      // The capture offer (1SI-4098) would start a real device flow from any test that starts a
      // session with nothing set up; only its own tests turn it back on.
      env: { ...process.env, HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME, BONEZ_SESSION_SYNC_QUIET_MS: "0", BONEZ_CAPTURE_OFFER: "0", ...env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => {
      stdout += d
    })
    child.stderr.on("data", (d) => {
      stderr += d
    })
    child.on("error", reject)
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr, ms: performance.now() - t0 })
    })
    child.stdin.end(input)
  })
}

async function install(dataDir, extraArgs = ["--global"]) {
  const res = await runCli(["install", TEST_KEY, ...extraArgs], { env: { CLAUDE_PLUGIN_DATA: dataDir } })
  assert.equal(res.status, 0, `install failed: ${res.stderr}`)
  return res
}

function ndjsonLinesFromGzip(buf) {
  return gunzipSync(buf)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

// Waits for `check()` to return truthy, polling briefly — used only to prove the detached
// background path (spawned by `hook`, not called directly) really completes, without a fixed
// sleep racing the child's own scheduling.
async function waitFor(check, { timeoutMs = 4000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = check()
    if (v) return v
    if (Date.now() > deadline) throw new Error("waitFor: timed out")
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

let gateway
before(async () => {
  gateway = await startStubGateway()
})
after(async () => {
  await gateway.close()
})

// ---------------------------------------------------------------------------- pure helpers

describe("pure helpers (imported directly — isMain guard keeps this from dispatching the CLI)", () => {
  test("shouldSkip / contentHashOf / gatewayBaseUrl / buildBundle", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")

    // contentHashOf: stable for identical messages, different for different messages.
    const conv1 = { messages: [{ role: "user", text: "a" }] }
    const conv2 = { messages: [{ role: "user", text: "a" }] }
    const conv3 = { messages: [{ role: "user", text: "b" }] }
    assert.equal(mod.contentHashOf(conv1), mod.contentHashOf(conv2))
    assert.notEqual(mod.contentHashOf(conv1), mod.contentHashOf(conv3))

    // shouldSkip: no prior state -> proceed.
    assert.equal(mod.shouldSkip({}, "s1", 3, "hash-a"), null)
    // Inside debounce -> skip regardless of content change.
    const debounceState = { s1: { lastUploadedAt: Date.now(), messageCount: 1, contentHash: "old" } }
    assert.match(mod.shouldSkip(debounceState, "s1", 99, "new-hash"), /debounce/)
    // Outside debounce, unchanged content -> skip.
    const staleUnchanged = { s1: { lastUploadedAt: Date.now() - 10 * 60_000, messageCount: 3, contentHash: "hash-a" } }
    assert.match(mod.shouldSkip(staleUnchanged, "s1", 3, "hash-a"), /unchanged/)
    // Outside debounce, changed content -> proceed.
    const staleChanged = { s1: { lastUploadedAt: Date.now() - 10 * 60_000, messageCount: 3, contentHash: "hash-a" } }
    assert.equal(mod.shouldSkip(staleChanged, "s1", 4, "hash-b"), null)

    // gatewayBaseUrl: default, explicit override, MCP-URL-derived fallback.
    const savedGw = process.env.BONEZ_GATEWAY_URL
    const savedMcp = process.env.BONEZ_MCP_URL
    try {
      delete process.env.BONEZ_GATEWAY_URL
      delete process.env.BONEZ_MCP_URL
      assert.equal(mod.gatewayBaseUrl(), "https://gateway.bonez.io")
      process.env.BONEZ_GATEWAY_URL = "https://qa.gateway.bonez.io/"
      assert.equal(mod.gatewayBaseUrl(), "https://qa.gateway.bonez.io")
      delete process.env.BONEZ_GATEWAY_URL
      process.env.BONEZ_MCP_URL = "https://qa.gateway.bonez.io/mcp"
      assert.equal(mod.gatewayBaseUrl(), "https://qa.gateway.bonez.io")
    } finally {
      if (savedGw === undefined) delete process.env.BONEZ_GATEWAY_URL
      else process.env.BONEZ_GATEWAY_URL = savedGw
      if (savedMcp === undefined) delete process.env.BONEZ_MCP_URL
      else process.env.BONEZ_MCP_URL = savedMcp
    }

    // buildBundle: exact manifest field set, matching packages/desktop/src/main/import/index.ts
    // (harness-ui, verified by reading that file directly — see the PR body).
    const conversation = {
      agent: "claude-code",
      sessionId: "sess-1",
      title: "t",
      workspacePath: "/tmp/x",
      repo: "/tmp/x",
      createdAt: 1,
      updatedAt: 2,
      messages: [{ role: "user", text: "hi" }],
      sourcePath: "/tmp/x/sess-1.jsonl",
    }
    const { ndjson, gz } = mod.buildBundle({
      agent: "claude",
      scope: "repo",
      repos: ["/tmp/x"],
      conversation,
      scrubReport: { total: 0, byType: {} },
    })
    const lines = ndjson
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].type, "manifest")
    assert.equal(lines[1].type, "conversation")
    assert.deepEqual(
      Object.keys(lines[0]).sort(),
      [
        "agents",
        "artifactCount",
        "conversationCount",
        "extractedAt",
        "hostname",
        "messageCount",
        "platform",
        "repos",
        "scope",
        "scrubReport",
        "tool",
        "type",
      ].sort(),
    )
    assert.deepEqual(lines[0].agents, ["claude-code"])
    assert.equal(lines[0].scope, "repo")
    assert.equal(lines[0].conversationCount, 1)
    assert.equal(lines[0].messageCount, 1)
    // conversation line is `{type, ...conversation}` verbatim — camelCase, unmodified — because
    // the pipeline's agent_convos.py `_KEY_MAP` maps FROM this exact camelCase shape.
    assert.equal(lines[1].sessionId, "sess-1")
    assert.equal(lines[1].sourcePath, "/tmp/x/sess-1.jsonl")
    assert.ok(gz.length > 0)
  })
})

// ---------------------------------------------------------------------------- install / status / disable

describe("install / status / disable / enable", () => {
  test("round-trips config without exposing any API key characters in status", async () => {
    const dataDir = freshDir("cfg")
    const res = await install(dataDir, ["--repo", "/tmp/some-repo"])
    assert.match(res.stdout, /installed and ENABLED/)
    assert.doesNotMatch(res.stdout, new RegExp(TEST_KEY)) // consent text must not print the raw key

    const status = await runCli(["status"], { env: { CLAUDE_PLUGIN_DATA: dataDir } })
    assert.equal(status.status, 0)
    assert.match(status.stdout, /sign-in:\s+API key configured/im)
    assert.doesNotMatch(status.stdout, new RegExp(TEST_KEY.slice(0, 10)))
    assert.match(status.stdout, /enabled/)
    assert.match(status.stdout, /\/tmp\/some-repo/)

    const disable = await runCli(["disable"], { env: { CLAUDE_PLUGIN_DATA: dataDir } })
    assert.equal(disable.status, 0)
    const statusAfterDisable = await runCli(["status"], { env: { CLAUDE_PLUGIN_DATA: dataDir } })
    assert.match(statusAfterDisable.stdout, /disabled/)

    const enable = await runCli(["enable"], { env: { CLAUDE_PLUGIN_DATA: dataDir } })
    assert.equal(enable.status, 0)
    const finalStatus = await runCli(["status"], { env: { CLAUDE_PLUGIN_DATA: dataDir } })
    assert.match(finalStatus.stdout, /^bonez session capture: enabled/)

    rmSync(dataDir, { recursive: true, force: true })
  })

  test("config.json is written mode 600", async () => {
    const dataDir = freshDir("perm")
    await install(dataDir)
    const mode = (statSync(join(dataDir, "config.json")).mode & 0o777).toString(8)
    assert.equal(mode, "600")
    rmSync(dataDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------- OAuth lane

describe("OAuth credential lane (1SI-1033)", () => {
  test("hasCredential / describeCredential — two lanes, and neither leaks the secret", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")

    assert.equal(mod.hasCredential(null), false)
    assert.equal(mod.hasCredential({}), false)
    assert.equal(mod.hasCredential({ apiKey: TEST_KEY }), true)
    assert.equal(mod.hasCredential({ oauth: { refreshToken: "rt" } }), true)
    // An access token with no refresh token still counts as installed — it works until it
    // expires, and `describeCredential` is what says so out loud.
    assert.equal(mod.hasCredential({ oauth: { accessToken: "at" } }), true)

    // `status` output gets pasted into issues. The raw secret must never be in it.
    const keyLine = mod.describeCredential({ apiKey: TEST_KEY })
    assert.doesNotMatch(keyLine, new RegExp(TEST_KEY))
    const oauthLine = mod.describeCredential({
      oauth: { accessToken: "at-secret-value", refreshToken: "rt-secret-value", expiresAt: Date.now() + 600_000 },
    })
    assert.doesNotMatch(oauthLine, /at-secret-value|rt-secret-value/)
    assert.match(oauthLine, /OAuth/)
    assert.match(mod.describeCredential({ oauth: { accessToken: "x", expiresAt: Date.now() - 1 } }), /expired/)
    assert.match(mod.describeCredential({ oauth: { accessToken: "x", expiresAt: Date.now() + 600_000 } }),
                 /no refresh token/)
  })

  test("discoverAuthServer walks gateway metadata -> AS metadata, hardcoding nothing", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")
    const as = await startStubOAuth()
    try {
      const found = await mod.discoverAuthServer(as.url)
      assert.equal(found.deviceEndpoint, `${as.url}/oauth/device/code`)
      assert.equal(found.tokenEndpoint, `${as.url}/oauth/token`)
      assert.equal(found.resource, `${as.url}/mcp`)
      // Both documents were actually read — the endpoints came from discovery, not a constant.
      assert.equal(as.calls.prm, 1)
      assert.equal(as.calls.oidc, 1)
    } finally {
      await as.close()
    }
  })

  test("discoverAuthServer says which document failed, not just that something did", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")
    await assert.rejects(
      () => mod.discoverAuthServer("http://127.0.0.1:1"),
      (err) => /OAuth metadata|fetch failed|ECONNREFUSED/.test(err.message),
    )
  })

  test("resolveBearer: an API key wins and costs no round trip", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")
    const as = await startStubOAuth()
    try {
      const bearer = await mod.resolveBearer({ apiKey: TEST_KEY, oauth: { refreshToken: "rt" } }, as.url)
      assert.equal(bearer, TEST_KEY)
      assert.equal(as.calls.token.length, 0)
      assert.equal(as.calls.prm, 0)
    } finally {
      await as.close()
    }
  })

  test("resolveBearer: a still-valid access token is reused as-is", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")
    const as = await startStubOAuth()
    try {
      const cfg = { oauth: { accessToken: "at-live", refreshToken: "rt", expiresAt: Date.now() + 30 * 60_000 } }
      assert.equal(await mod.resolveBearer(cfg, as.url), "at-live")
      assert.equal(as.calls.token.length, 0)
    } finally {
      await as.close()
    }
  })

  test("resolveBearer: an expiring token refreshes, and the new one is persisted", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")
    const dataDir = freshDir("oauth-refresh")
    const as = await startStubOAuth({ rotateRefreshToken: "rt-2" })
    const savedDataDir = process.env.CLAUDE_PLUGIN_DATA
    process.env.CLAUDE_PLUGIN_DATA = dataDir
    try {
      // Inside TOKEN_SKEW_MS of expiry, so it must refresh rather than hand back a token that
      // would expire mid-upload.
      const cfg = { enabled: true, scope: "global", repos: [],
                    oauth: { accessToken: "at-stale", refreshToken: "rt-1", expiresAt: Date.now() + 30_000 } }
      writeFileSync(join(dataDir, "config.json"), JSON.stringify(cfg))

      const bearer = await mod.resolveBearer(cfg, as.url)
      assert.equal(bearer, "at-refreshed-1")
      assert.equal(as.calls.token[0].grant_type, "refresh_token")
      assert.equal(as.calls.token[0].refresh_token, "rt-1")

      const written = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"))
      assert.equal(written.oauth.accessToken, "at-refreshed-1")
      // Auth0 rotated the refresh token; the rotated one must be what we keep.
      assert.equal(written.oauth.refreshToken, "rt-2")
      // Fields the refresh has no business touching survive it.
      assert.equal(written.enabled, true)
      assert.equal(written.scope, "global")
    } finally {
      if (savedDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA
      else process.env.CLAUDE_PLUGIN_DATA = savedDataDir
      await as.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test("resolveBearer: a non-rotating AS keeps the refresh token it already had", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")
    const dataDir = freshDir("oauth-norotate")
    const as = await startStubOAuth({ rotateRefreshToken: null })
    const savedDataDir = process.env.CLAUDE_PLUGIN_DATA
    process.env.CLAUDE_PLUGIN_DATA = dataDir
    try {
      const cfg = { oauth: { accessToken: "at-stale", refreshToken: "rt-keep", expiresAt: Date.now() - 1 } }
      writeFileSync(join(dataDir, "config.json"), JSON.stringify(cfg))
      await mod.resolveBearer(cfg, as.url)
      const written = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"))
      // Storing null here would lock the user out of every future refresh silently.
      assert.equal(written.oauth.refreshToken, "rt-keep")
    } finally {
      if (savedDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA
      else process.env.CLAUDE_PLUGIN_DATA = savedDataDir
      await as.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test("resolveBearer: no credential, and an expired one with no refresh token, both say what to do", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")
    await assert.rejects(() => mod.resolveBearer({}, "http://127.0.0.1:1"), /login.*install|install.*login/s)
    await assert.rejects(
      () => mod.resolveBearer({ oauth: { accessToken: "at", expiresAt: Date.now() - 1 } }, "http://127.0.0.1:1"),
      /run `login` again/,
    )
  })

  test("login refuses cleanly when no OAuth client is configured in this build", async () => {
    const dataDir = freshDir("oauth-unconfigured")
    const res = await runCli(["login", "--global"], {
      env: {
        CLAUDE_PLUGIN_DATA: dataDir,
        // An EXPLICIT empty value means "this build has no client". The guard reads it with
        // `??` for exactly this reason: under `||` the empty string looks unset, falls back
        // to the shipped client id, and this test starts a REAL device flow against the real
        // Auth0 and polls it for fifteen minutes. That is how the bug was found.
        BONEZ_OAUTH_CLIENT_ID: "",
        // Belt to that braces: even if the guard regresses, discovery has nowhere to go, so
        // the test fails in a second instead of hanging. A test whose failure mode is a
        // 15-minute stall is a test nobody will run.
        BONEZ_GATEWAY_URL: "http://127.0.0.1:1",
      },
    })
    assert.equal(res.status, 1)
    // Points at the lane that DOES work rather than failing somewhere inside the device flow.
    assert.match(res.stderr, /install <bnz_\.\.\.key>/)
    assert.equal(existsSync(join(dataDir, "config.json")), false)
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("login: full device flow, polls through authorization_pending, stores no key", async () => {
    const dataDir = freshDir("oauth-login")
    const as = await startStubOAuth({ pendingPolls: 2 })
    try {
      const res = await runCli(["login", "--global"], {
        env: {
          CLAUDE_PLUGIN_DATA: dataDir,
          BONEZ_GATEWAY_URL: as.url,
          BONEZ_OAUTH_CLIENT_ID: "test-client",
          BONEZ_DEVICE_POLL_FLOOR_MS: "1",
        },
      })
      assert.equal(res.status, 0, res.stderr)
      // The user is told where to go and what happens next.
      assert.match(res.stdout, /\/activate\?user_code=WXYZ-1234/)
      assert.match(res.stdout, /installed and ENABLED/)
      assert.match(res.stdout, /cannot read the System Model/)

      // It asked for exactly the upload-only scope, against the resource discovery named.
      assert.equal(as.calls.device[0].client_id, "test-client")
      assert.equal(as.calls.device[0].scope, "bonez:sessions offline_access")
      assert.equal(as.calls.device[0].audience, `${as.url}/mcp`)

      // RFC 8628 §3.5: it kept polling instead of giving up on the first pending answer.
      assert.equal(as.calls.token.length, 3)
      assert.equal(as.calls.token[0].grant_type, "urn:ietf:params:oauth:grant-type:device_code")

      const cfg = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"))
      assert.equal(cfg.oauth.accessToken, "at-1")
      assert.equal(cfg.oauth.refreshToken, "rt-1")
      assert.equal(cfg.enabled, true)
      assert.equal(cfg.scope, "global")
      // The whole point: nothing pasted, nothing key-shaped on disk.
      assert.equal(cfg.apiKey, undefined)
      assert.doesNotMatch(readFileSync(join(dataDir, "config.json"), "utf8"), /bnz_/)
      assert.equal((statSync(join(dataDir, "config.json")).mode & 0o777).toString(8), "600")
    } finally {
      await as.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test("login refuses a credential with a fuse in it — no refresh token, no install", async () => {
    const dataDir = freshDir("oauth-norefresh")
    const as = await startStubOAuth({ refreshTokenOnLogin: null })
    try {
      const res = await runCli(["login", "--global"], {
        env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: as.url, BONEZ_OAUTH_CLIENT_ID: "test-client",
               BONEZ_DEVICE_POLL_FLOOR_MS: "1" },
      })
      assert.equal(res.status, 1)
      assert.match(res.stderr, /offline access/)
      // Capture would have died silently within the hour, in a background process nobody
      // watches. Nothing must be written.
      assert.equal(existsSync(join(dataDir, "config.json")), false)
    } finally {
      await as.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test("logout removes both lanes and stops capture", async () => {
    const dataDir = freshDir("oauth-logout")
    const as = await startStubOAuth()
    try {
      await runCli(["login", "--global"], {
        env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: as.url, BONEZ_OAUTH_CLIENT_ID: "test-client",
               BONEZ_DEVICE_POLL_FLOOR_MS: "1" },
      })
      const res = await runCli(["logout"], { env: { CLAUDE_PLUGIN_DATA: dataDir } })
      assert.equal(res.status, 0)
      const cfg = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"))
      assert.equal(cfg.oauth, undefined)
      assert.equal(cfg.apiKey, undefined)
      assert.equal(cfg.enabled, false)
    } finally {
      await as.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------- _upload (direct)

describe("_upload — Claude Code leg against the stub gateway", () => {
  let dataDir
  let payloadFile

  before(async () => {
    dataDir = freshDir("claude-upload")
    await install(dataDir, ["--global"])
  })
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  test("presign -> PUT -> complete happens with the right headers, agent, scope, and bundle bytes; secret is redacted", async () => {
    payloadFile = join(dataDir, "payload.json")
    writeFileSync(
      payloadFile,
      JSON.stringify({
        session_id: "claude-transcript",
        transcript_path: join(FIXTURES, "claude-transcript.jsonl"),
        cwd: "/tmp/bonez-session-sync-fixture-repo",
        hook_event_name: "SessionEnd",
        reason: "other",
      }),
    )
    const beforeCounts = { presign: gateway.calls.presign.length, put: gateway.calls.put.length, complete: gateway.calls.complete.length }

    const res = await runCli(["_upload", "claude", "session-end", payloadFile], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url },
    })
    assert.equal(res.status, 0)
    assert.equal(res.stdout, "")

    assert.equal(gateway.calls.presign.length, beforeCounts.presign + 1)
    assert.equal(gateway.calls.put.length, beforeCounts.put + 1)
    assert.equal(gateway.calls.complete.length, beforeCounts.complete + 1)

    const presignCall = gateway.calls.presign.at(-1)
    assert.equal(presignCall.headers.authorization, `Bearer ${TEST_KEY}`)
    assert.equal(presignCall.body.agent, "claude-code")
    assert.equal(presignCall.body.scope, "global")

    const putCall = gateway.calls.put.at(-1)
    assert.equal(putCall.headers["content-type"], "application/gzip")

    const completeCall = gateway.calls.complete.at(-1)
    assert.equal(completeCall.headers.authorization, `Bearer ${TEST_KEY}`)
    // Same upload_id flows presign response -> PUT url -> complete url.
    assert.equal(completeCall.uploadId, putCall.uploadId)

    const lines = ndjsonLinesFromGzip(putCall.body)
    assert.equal(lines.length, 2)
    const [manifest, conversation] = lines
    assert.equal(manifest.type, "manifest")
    assert.deepEqual(manifest.agents, ["claude-code"])
    assert.equal(manifest.scope, "global")
    assert.equal(conversation.type, "conversation")
    assert.equal(conversation.agent, "claude-code")
    assert.equal(conversation.sessionId, "claude-transcript")
    assert.equal(conversation.messages.length, 4)

    const raw = JSON.stringify(conversation)
    assert.ok(!raw.includes(FAKE_API_KEY))
    assert.match(raw, /\*\*\*\*/)
    assert.ok(manifest.scrubReport.total >= 1)

    const state = JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf8"))
    assert.ok(state["claude-transcript"])
    assert.equal(state["claude-transcript"].messageCount, 4)
  })

  test("re-running immediately with unchanged content is a no-op (dedup)", async () => {
    const before = gateway.calls.presign.length
    const f = join(dataDir, "payload2.json")
    writeFileSync(f, JSON.stringify({ session_id: "claude-transcript", transcript_path: join(FIXTURES, "claude-transcript.jsonl") }))
    const res = await runCli(["_upload", "claude", "session-end", f], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url },
    })
    assert.equal(res.status, 0)
    assert.equal(gateway.calls.presign.length, before, "dedup should prevent a second presign call")

    const log = readFileSync(join(dataDir, "sync.log"), "utf8")
    assert.match(log, /skipped/)
  })

  test("a real content change past the debounce window re-uploads", async () => {
    const changedDir = freshDir("claude-upload-changed")
    await install(changedDir, ["--global"])
    const changedTranscript = join(changedDir, "transcript.jsonl")
    cpSync(join(FIXTURES, "claude-transcript.jsonl"), changedTranscript)
    const payloadFile2 = join(changedDir, "payload.json")
    writeFileSync(payloadFile2, JSON.stringify({ session_id: "changing-session", transcript_path: changedTranscript }))

    const first = await runCli(["_upload", "claude", "session-end", payloadFile2], {
      env: { CLAUDE_PLUGIN_DATA: changedDir, BONEZ_GATEWAY_URL: gateway.url, BONEZ_SESSION_SYNC_DEBOUNCE_MS: "0" },
    })
    assert.equal(first.status, 0)
    const afterFirst = gateway.calls.presign.length

    // Append a new message so message count + content hash both change.
    writeFileSync(
      changedTranscript,
      `${readFileSync(changedTranscript, "utf8")}\n{"type":"user","timestamp":"2026-08-24T10:01:00.000Z","message":{"role":"user","content":"one more thing"}}\n`,
    )
    writeFileSync(payloadFile2, JSON.stringify({ session_id: "changing-session", transcript_path: changedTranscript }))
    const second = await runCli(["_upload", "claude", "session-end", payloadFile2], {
      env: { CLAUDE_PLUGIN_DATA: changedDir, BONEZ_GATEWAY_URL: gateway.url, BONEZ_SESSION_SYNC_DEBOUNCE_MS: "0" },
    })
    assert.equal(second.status, 0)
    assert.equal(gateway.calls.presign.length, afterFirst + 1, "changed content past the debounce window must re-upload")

    rmSync(changedDir, { recursive: true, force: true })
  })
})

describe("_upload — Codex leg against the stub gateway", () => {
  test("SessionEnd: agent=codex in the manifest, github token redacted", async () => {
    const dataDir = freshDir("codex-upload")
    await install(dataDir, ["--global"])
    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(
      payloadFile,
      JSON.stringify({
        session_id: "codex-rollout",
        turn_id: "turn-1",
        cwd: "/tmp/bonez-session-sync-fixture-repo",
        transcript_path: join(FIXTURES, "codex-rollout.jsonl"),
      }),
    )
    const res = await runCli(["_upload", "codex", "session-end", payloadFile], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url },
    })
    assert.equal(res.status, 0)
    const putCall = gateway.calls.put.at(-1)
    const [manifest, conversation] = ndjsonLinesFromGzip(putCall.body)
    assert.deepEqual(manifest.agents, ["codex"])
    assert.equal(conversation.agent, "codex")
    const raw = JSON.stringify(conversation)
    assert.ok(!raw.includes(FAKE_GITHUB_TOKEN))
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("SessionStart: no transcript_path in payload — resolves from session_id and flushes ONE prior unsynced session, not the new one", async () => {
    const fakeHome = freshDir("codex-home")
    const day = join(fakeHome, ".codex", "sessions", "2026", "08", "24")
    mkdirSync(day, { recursive: true })
    const oldSessionId = "old-session-abc"
    const newSessionId = "new-session-xyz"
    cpSync(join(FIXTURES, "codex-rollout.jsonl"), join(day, `rollout-2026-08-24T10-00-00-${oldSessionId}.jsonl`))
    writeFileSync(
      join(day, `rollout-2026-08-24T11-00-00-${newSessionId}.jsonl`),
      `${readFileSync(join(FIXTURES, "codex-rollout.jsonl"), "utf8")}\n`,
    )
    // The new session's own file must be strictly newer so it isn't picked as the catch-up
    // target — cpSync above already gives the old file an earlier mtime in practice, but pin it
    // explicitly so the test doesn't depend on filesystem timing.
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(day, `rollout-2026-08-24T10-00-00-${oldSessionId}.jsonl`), past, past)

    const dataDir = freshDir("codex-start")
    await install(dataDir, ["--global"])
    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(payloadFile, JSON.stringify({ session_id: newSessionId, cwd: "/tmp/x", source: "startup" }))

    const before = gateway.calls.presign.length
    const res = await runCli(["_upload", "codex", "session-start", payloadFile], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url, HOME: fakeHome },
    })
    assert.equal(res.status, 0)
    assert.equal(gateway.calls.presign.length, before + 1)

    const state = JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf8"))
    // The local dedup key is the parsed conversation's own sessionId — for Codex that's the
    // whole `rollout-<timestamp>-<id>` filename stem (parseCodexFile's convention), not the
    // bare id alone.
    const oldStateKey = `rollout-2026-08-24T10-00-00-${oldSessionId}`
    assert.ok(state[oldStateKey], "the OLD (previous) session should have been caught up")
    assert.ok(
      !Object.keys(state).some((k) => k.includes(newSessionId)),
      "the NEW (just-starting) session must not be uploaded from its own SessionStart",
    )

    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })
})

// ------------------------------------------------------------- cursor stop / concurrent chats

describe("Cursor `stop`: concurrent conversations each capture themselves", () => {
  // The reason `stop` is the primary trigger: it fires while the window is alive, once per
  // agent loop, INDEPENDENTLY PER CONVERSATION. sessionEnd cannot run at all on window_close,
  // and a start-side catch-up serialises everything through one slot. This is the behaviour
  // that has to hold, so it is asserted rather than assumed.
  function writeTranscript(dir, id, turns) {
    mkdirSync(dir, { recursive: true })
    const lines = []
    for (let i = 0; i < turns; i++) {
      lines.push(JSON.stringify({ role: "user", message: { content: [{ type: "text", text: `<user_query>${id} q${i}</user_query>` }] } }))
      lines.push(JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: `${id} a${i}` }] } }))
    }
    const f = join(dir, `${id}.jsonl`)
    writeFileSync(f, `${lines.join("\n")}\n`)
    return f
  }

  test("three chats open at once: each turn uploads its OWN conversation, none bleed", async () => {
    const home = freshDir("cursor-stop-concurrent")
    const dataDir = freshDir("cursor-stop-data")
    await install(dataDir, ["--global"])
    const root = "/tmp/bonez-session-sync-fixture-repo"
    const slug = "tmp-bonez-session-sync-fixture-repo"
    const base = join(home, ".cursor", "projects", slug, "agent-transcripts")

    const chats = ["chat-alpha", "chat-beta", "chat-gamma"]
    const paths = {}
    for (const id of chats) paths[id] = writeTranscript(join(base, id), id, 2)

    const env = {
      CLAUDE_PLUGIN_DATA: dataDir,
      BONEZ_GATEWAY_URL: gateway.url,
      HOME: home,
      USERPROFILE: home,
      BONEZ_SESSION_SYNC_DEBOUNCE_MS: "0",
    }

    // Interleave turns the way three open chats actually behave.
    for (const id of [...chats, ...chats]) {
      const payloadFile = join(dataDir, `p-${id}.json`)
      writeFileSync(
        payloadFile,
        JSON.stringify({
          hook_event_name: "stop",
          status: "completed",
          loop_count: 0,
          conversation_id: id,
          workspace_roots: [root],
          transcript_path: paths[id],
        }),
      )
      // grow the transcript between rounds so the content hash actually changes
      writeTranscript(join(base, id), id, 4)
      const res = await runCli(["_upload", "cursor", "turn-end", payloadFile], { env })
      assert.equal(res.status, 0)
    }

    const state = JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf8"))
    for (const id of chats) {
      assert.ok(state[id], `${id} must have its own sync-state entry`)
      assert.equal(state[id].agent, "cursor")
    }

    // Every upload carried the right conversation — an id landing under another chat's
    // unit_key would silently merge two people's work into one :Convo node.
    //
    // Select by sessionId rather than by position: the stub gateway is shared with every
    // other test in this file and node:test runs suites concurrently, so "the last N PUTs"
    // is not this test's N PUTs.
    const uploaded = gateway.calls.put
      .map((c) => ndjsonLinesFromGzip(c.body)[1])
      .filter((conv) => chats.includes(conv.sessionId))
    assert.deepEqual(new Set(uploaded.map((c) => c.sessionId)), new Set(chats), "each chat must upload under its own id")
    for (const conv of uploaded) {
      for (const m of conv.messages) {
        if (m.text) assert.ok(m.text.includes(conv.sessionId), "a message from another conversation leaked in")
      }
    }

    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("simultaneous uploaders do not clobber each other's sync-state", async () => {
    // The race this closes: three chats -> three detached uploaders -> each loads
    // sync-state, adds its entry, writes it back. Without a lock the last writer wins and
    // the others vanish, so those conversations look never-uploaded and get re-uploaded on
    // the next turn — defeating the debounce that makes per-turn `stop` affordable.
    // Measured before the fix: 3 concurrent uploads, 1 surviving entry.
    const home = freshDir("cursor-state-race")
    const dataDir = freshDir("cursor-state-race-data")
    await install(dataDir, ["--global"])
    const root = "/tmp/bonez-session-sync-fixture-repo"
    const base = join(home, ".cursor", "projects", "tmp-bonez-session-sync-fixture-repo", "agent-transcripts")

    const ids = ["race-1", "race-2", "race-3", "race-4", "race-5"]
    const env = {
      CLAUDE_PLUGIN_DATA: dataDir,
      BONEZ_GATEWAY_URL: gateway.url,
      HOME: home,
      USERPROFILE: home,
      BONEZ_SESSION_SYNC_DEBOUNCE_MS: "0",
    }

    // Launch all five AT ONCE — sequential runs would never exhibit the bug.
    await Promise.all(
      ids.map((id) => {
        writeTranscript(join(base, id), id, 2)
        const payloadFile = join(dataDir, `race-${id}.json`)
        writeFileSync(
          payloadFile,
          JSON.stringify({
            hook_event_name: "stop",
            conversation_id: id,
            workspace_roots: [root],
            transcript_path: join(base, id, `${id}.jsonl`),
          }),
        )
        return runCli(["_upload", "cursor", "turn-end", payloadFile], { env })
      }),
    )

    const state = JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf8"))
    const missing = ids.filter((id) => !state[id])
    assert.deepEqual(missing, [], `sync-state lost ${missing.length}/${ids.length} entries to a write race`)

    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("rapid turns in one chat collapse to a single upload — `stop` fires per turn, we don't", async () => {
    const home = freshDir("cursor-stop-debounce")
    const dataDir = freshDir("cursor-stop-debounce-data")
    await install(dataDir, ["--global"])
    const root = "/tmp/bonez-session-sync-fixture-repo"
    const base = join(home, ".cursor", "projects", "tmp-bonez-session-sync-fixture-repo", "agent-transcripts", "chatty")
    const f = writeTranscript(base, "chatty", 1)
    const payloadFile = join(dataDir, "p.json")
    // Default debounce (120s) — the point of this test.
    const env = { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url, HOME: home, USERPROFILE: home }

    const before = gateway.calls.presign.length
    for (let turn = 1; turn <= 5; turn++) {
      writeTranscript(base, "chatty", turn + 1) // genuinely different content each turn
      writeFileSync(
        payloadFile,
        JSON.stringify({ hook_event_name: "stop", conversation_id: "chatty", workspace_roots: [root], transcript_path: f }),
      )
      assert.equal((await runCli(["_upload", "cursor", "turn-end", payloadFile], { env })).status, 0)
    }
    assert.equal(
      gateway.calls.presign.length,
      before + 1,
      "five turns inside the debounce window must produce ONE upload, not five archives",
    )
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("the hook path itself accepts turn-end: fast, silent, exit 0", async () => {
    const dataDir = freshDir("cursor-stop-hook")
    await install(dataDir, ["--global"])
    const res = await runCli(["hook", "cursor", "turn-end"], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url },
      input: JSON.stringify({
        hook_event_name: "stop",
        conversation_id: "cursor-transcript",
        workspace_roots: ["/tmp/bonez-session-sync-fixture-repo"],
        transcript_path: join(FIXTURES, "cursor-transcript.jsonl"),
      }),
    })
    assert.equal(res.status, 0)
    // `stop` can return a followup_message that Cursor AUTO-SUBMITS as a user turn, so
    // anything printed here would be injected into the conversation.
    assert.equal(res.stdout, "", "a stop hook that prints would inject text into the chat")
    assert.equal(res.stderr, "")
    assert.ok(res.ms < 500, `hook wall time was ${res.ms.toFixed(1)}ms`)
    await waitFor(() => {
      if (!existsSync(join(dataDir, "sync-state.json"))) return false
      try {
        return JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf8"))["cursor-transcript"]
      } catch {
        return false
      }
    })
    rmSync(dataDir, { recursive: true, force: true })
  })
})

// ------------------------------------------------------------------- cursor sessionStart catch-up

describe("Cursor sessionStart catch-up (the path that survives window_close)", () => {
  // Cursor 3.18.25 tears down shell-exec before running sessionEnd hooks on window_close, so
  // every command hook in that batch fails with "MainThreadShellExec not initialized". Capture
  // therefore cannot depend on sessionEnd; it flushes from disk on the next start instead.
  function seedWorkspace(home, slug, ids) {
    for (const id of ids) {
      const dir = join(home, ".cursor", "projects", slug, "agent-transcripts", id)
      mkdirSync(dir, { recursive: true })
      cpSync(join(FIXTURES, "cursor-transcript.jsonl"), join(dir, `${id}.jsonl`))
    }
  }

  test("flushes EVERY stale conversation, not just one — concurrent chats all die together on window_close", async () => {
    const home = freshDir("cursor-concurrent")
    const root = "/tmp/bonez-session-sync-fixture-repo"
    const slug = "tmp-bonez-session-sync-fixture-repo"
    seedWorkspace(home, slug, ["chat-a", "chat-b", "chat-c", "chat-d"])
    const dataDir = freshDir("cursor-concurrent-data")
    await install(dataDir, ["--global"])
    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(payloadFile, JSON.stringify({ conversation_id: "the-new-one", workspace_roots: [root] }))

    const before = gateway.calls.presign.length
    const res = await runCli(["_upload", "cursor", "session-start", payloadFile], {
      env: {
        CLAUDE_PLUGIN_DATA: dataDir,
        BONEZ_GATEWAY_URL: gateway.url,
        HOME: home,
        USERPROFILE: home,
        BONEZ_SESSION_SYNC_DEBOUNCE_MS: "0",
      },
    })
    assert.equal(res.status, 0)
    assert.equal(gateway.calls.presign.length, before + 4, "all four stranded conversations must flush, not one")
    const state = JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf8"))
    for (const id of ["chat-a", "chat-b", "chat-c", "chat-d"]) assert.ok(state[id], `${id} should have flushed`)
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("a conversation that GREW since its last upload is picked up again", async () => {
    const home = freshDir("cursor-grew")
    const root = "/tmp/bonez-session-sync-fixture-repo"
    const slug = "tmp-bonez-session-sync-fixture-repo"
    seedWorkspace(home, slug, ["grown"])
    const f = join(home, ".cursor", "projects", slug, "agent-transcripts", "grown", "grown.jsonl")

    const dataDir = freshDir("cursor-grew-data")
    await install(dataDir, ["--global"])
    // Already uploaded an hour ago...
    writeFileSync(
      join(dataDir, "sync-state.json"),
      JSON.stringify({ grown: { agent: "cursor", messageCount: 2, contentHash: "stale", lastUploadedAt: Date.now() - 3_600_000 } }),
    )
    // ...and the user kept chatting in it since.
    const now = new Date()
    utimesSync(f, now, now)

    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(payloadFile, JSON.stringify({ conversation_id: "another", workspace_roots: [root] }))
    const before = gateway.calls.presign.length
    const res = await runCli(["_upload", "cursor", "session-start", payloadFile], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url, HOME: home, USERPROFILE: home },
    })
    assert.equal(res.status, 0)
    assert.equal(
      gateway.calls.presign.length,
      before + 1,
      "keying on 'have we ever uploaded this' would blacklist a growing conversation forever",
    )
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("flushes the PREVIOUS conversation, never the one just starting", async () => {
    const home = freshDir("cursor-catchup")
    const root = "/tmp/bonez-session-sync-fixture-repo"
    const slug = "tmp-bonez-session-sync-fixture-repo" // workspace path with "/" -> "-"
    seedWorkspace(home, slug, ["old-convo", "new-convo"])
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(home, ".cursor", "projects", slug, "agent-transcripts", "old-convo", "old-convo.jsonl"), past, past)

    const dataDir = freshDir("cursor-catchup-data")
    await install(dataDir, ["--global"])
    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(
      payloadFile,
      JSON.stringify({ hook_event_name: "sessionStart", conversation_id: "new-convo", workspace_roots: [root] }),
    )

    const before = gateway.calls.presign.length
    const res = await runCli(["_upload", "cursor", "session-start", payloadFile], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url, HOME: home, USERPROFILE: home },
    })
    assert.equal(res.status, 0)
    assert.equal(gateway.calls.presign.length, before + 1)

    const state = JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf8"))
    assert.ok(state["old-convo"], "the previous conversation should have been flushed")
    assert.ok(!state["new-convo"], "the just-starting conversation must never be uploaded from its own start")
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("already-synced conversations are skipped, so a start is a silent no-op once caught up", async () => {
    const home = freshDir("cursor-caughtup")
    const root = "/tmp/bonez-session-sync-fixture-repo"
    seedWorkspace(home, "tmp-bonez-session-sync-fixture-repo", ["only-convo"])
    const dataDir = freshDir("cursor-caughtup-data")
    await install(dataDir, ["--global"])
    writeFileSync(
      join(dataDir, "sync-state.json"),
      JSON.stringify({
        "only-convo": { agent: "cursor", messageCount: 6, contentHash: "x", lastUploadedAt: Date.now() + 60_000 },
      }),
    )
    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(payloadFile, JSON.stringify({ conversation_id: "brand-new", workspace_roots: [root] }))

    const before = gateway.calls.presign.length
    const res = await runCli(["_upload", "cursor", "session-start", payloadFile], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url, HOME: home, USERPROFILE: home },
    })
    assert.equal(res.status, 0)
    assert.equal(gateway.calls.presign.length, before, "nothing left to catch up — must not re-upload")
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("the workspace slug is Cursor's own directory naming, not a guess", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")
    assert.equal(
      mod.cursorProjectSlug("/Users/shay/Projects/easycoach/pl-football-web"),
      "Users-shay-Projects-easycoach-pl-football-web",
      "must match the real directory Cursor wrote (observed in ~/.cursor/projects)",
    )
    assert.equal(mod.cursorProjectSlug("/tmp/repo/"), "tmp-repo")
    assert.equal(mod.cursorProjectSlug(""), null)
    assert.equal(mod.cursorProjectSlug(undefined), null)
  })
})

// ------------------------------------------------------------------- Claude catch-up + backfill

describe("Claude SessionStart catch-up (1SI-1102)", () => {
  // SessionEnd was the ONLY capture point on the Claude leg, so a crash, a kill, the hook's own
  // timeout — or the plugin sitting disabled for a week — lost the conversation with nothing to
  // notice it. Codex and Cursor both self-heal on their next start; these pin that Claude now
  // does too, and that it does so without re-uploading what is already current.
  function seedProjects(home, slug, ids) {
    const dir = join(home, ".claude", "projects", slug)
    mkdirSync(dir, { recursive: true })
    for (const id of ids) cpSync(join(FIXTURES, "claude-transcript.jsonl"), join(dir, `${id}.jsonl`))
    return dir
  }

  test("flushes a session whose SessionEnd never fired, and never the one just starting", async () => {
    const home = freshDir("claude-catchup")
    const cwd = "/tmp/bonez-session-sync-fixture-repo"
    const slug = "-tmp-bonez-session-sync-fixture-repo"
    const dir = seedProjects(home, slug, ["crashed-session", "the-new-one"])
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, "crashed-session.jsonl"), past, past)

    const dataDir = freshDir("claude-catchup-data")
    await install(dataDir, ["--global"])
    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(payloadFile, JSON.stringify({ hook_event_name: "SessionStart", session_id: "the-new-one", cwd }))

    const before = gateway.calls.presign.length
    const res = await runCli(["_upload", "claude", "session-start", payloadFile], {
      env: {
        CLAUDE_PLUGIN_DATA: dataDir,
        BONEZ_GATEWAY_URL: gateway.url,
        HOME: home,
        USERPROFILE: home,
        BONEZ_SESSION_SYNC_DEBOUNCE_MS: "0",
      },
    })
    assert.equal(res.status, 0)
    assert.equal(gateway.calls.presign.length, before + 1, "exactly the stranded session should flush")
    const state = JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf8"))
    assert.ok(state["crashed-session"], "the session that never got a SessionEnd must be recovered")
    assert.ok(!state["the-new-one"], "the session just starting is still being written — leave it alone")
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("a session that GREW since its last upload is picked up again", async () => {
    const home = freshDir("claude-grew")
    const cwd = "/tmp/bonez-session-sync-fixture-repo"
    const slug = "-tmp-bonez-session-sync-fixture-repo"
    const dir = seedProjects(home, slug, ["grown"])

    const dataDir = freshDir("claude-grew-data")
    await install(dataDir, ["--global"])
    writeFileSync(
      join(dataDir, "sync-state.json"),
      JSON.stringify({
        grown: { agent: "claude", messageCount: 2, contentHash: "stale", lastUploadedAt: Date.now() - 3_600_000 },
      }),
    )
    const now = new Date()
    utimesSync(join(dir, "grown.jsonl"), now, now)

    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(payloadFile, JSON.stringify({ session_id: "another", cwd }))
    const before = gateway.calls.presign.length
    const res = await runCli(["_upload", "claude", "session-start", payloadFile], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url, HOME: home, USERPROFILE: home },
    })
    assert.equal(res.status, 0)
    assert.equal(
      gateway.calls.presign.length,
      before + 1,
      "keying on 'have we ever uploaded this' would blacklist a growing session forever",
    )
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("already-synced sessions are skipped, so a start is a silent no-op once caught up", async () => {
    const home = freshDir("claude-caughtup")
    const cwd = "/tmp/bonez-session-sync-fixture-repo"
    const slug = "-tmp-bonez-session-sync-fixture-repo"
    const dir = seedProjects(home, slug, ["already-done"])

    const dataDir = freshDir("claude-caughtup-data")
    await install(dataDir, ["--global"])
    writeFileSync(
      join(dataDir, "sync-state.json"),
      JSON.stringify({
        "already-done": { agent: "claude", messageCount: 4, contentHash: "x", lastUploadedAt: Date.now() + 60_000 },
      }),
    )
    utimesSync(join(dir, "already-done.jsonl"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))

    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(payloadFile, JSON.stringify({ session_id: "fresh", cwd }))
    const before = gateway.calls.presign.length
    const res = await runCli(["_upload", "claude", "session-start", payloadFile], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url, HOME: home, USERPROFILE: home },
    })
    assert.equal(res.status, 0)
    assert.equal(gateway.calls.presign.length, before, "nothing stale — a start must not re-upload")
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("the catch-up is capped, so a long backlog drains over several starts", async () => {
    const home = freshDir("claude-cap")
    const cwd = "/tmp/bonez-session-sync-fixture-repo"
    const slug = "-tmp-bonez-session-sync-fixture-repo"
    seedProjects(home, slug, Array.from({ length: 9 }, (_, i) => `stale-${i}`))

    const dataDir = freshDir("claude-cap-data")
    await install(dataDir, ["--global"])
    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(payloadFile, JSON.stringify({ session_id: "current", cwd }))

    const before = gateway.calls.presign.length
    const res = await runCli(["_upload", "claude", "session-start", payloadFile], {
      env: {
        CLAUDE_PLUGIN_DATA: dataDir,
        BONEZ_GATEWAY_URL: gateway.url,
        HOME: home,
        USERPROFILE: home,
        BONEZ_SESSION_SYNC_DEBOUNCE_MS: "0",
      },
    })
    assert.equal(res.status, 0)
    assert.equal(
      gateway.calls.presign.length - before,
      5,
      "CLAUDE_CATCHUP_MAX bounds one start; the rest drain on later starts",
    )
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("the project-directory slug is Claude Code's own naming, not a guess", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")
    // Derived against all 162 project directories on a real machine. "/" and "." alone matched
    // only 93 of them — "_" flattens to "-" as well, and missing that finds nothing silently.
    assert.equal(mod.claudeProjectSlug("/Users/shay/Projects/bonez"), "-Users-shay-Projects-bonez")
    assert.equal(
      mod.claudeProjectSlug("/Users/shay/Projects/re_gent_headless"),
      "-Users-shay-Projects-re-gent-headless",
      "underscores flatten to dashes too — observed in ~/.claude/projects",
    )
    assert.equal(
      mod.claudeProjectSlug("/Users/shay/Projects/bonez/harness-ui/.claude-worktrees/x"),
      "-Users-shay-Projects-bonez-harness-ui--claude-worktrees-x",
      "a dot-directory yields the doubled dash the real tree shows",
    )
    assert.equal(mod.claudeProjectSlug("/tmp/repo/"), "-tmp-repo")
    assert.equal(mod.claudeProjectSlug(""), null)
    assert.equal(mod.claudeProjectSlug(undefined), null)
  })
})

describe("backfill: the accumulated history a per-start drip can never reach", () => {
  test("sweeps every project directory, not just one workspace", async () => {
    const home = freshDir("claude-backfill")
    for (const [slug, id] of [
      ["-tmp-repo-one", "one-a"],
      ["-tmp-repo-two", "two-a"],
      ["-tmp-repo-three", "three-a"],
    ]) {
      const dir = join(home, ".claude", "projects", slug)
      mkdirSync(dir, { recursive: true })
      cpSync(join(FIXTURES, "claude-transcript.jsonl"), join(dir, `${id}.jsonl`))
    }

    const dataDir = freshDir("claude-backfill-data")
    await install(dataDir, ["--global"])
    const before = gateway.calls.presign.length
    const res = await runCli(["backfill"], {
      env: {
        CLAUDE_PLUGIN_DATA: dataDir,
        BONEZ_GATEWAY_URL: gateway.url,
        HOME: home,
        USERPROFILE: home,
        BONEZ_SESSION_SYNC_DEBOUNCE_MS: "0",
      },
    })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(gateway.calls.presign.length - before, 3, "all three workspaces' history must be swept")
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("--dry-run reports the volume and uploads nothing", async () => {
    const home = freshDir("claude-backfill-dry")
    const dir = join(home, ".claude", "projects", "-tmp-repo")
    mkdirSync(dir, { recursive: true })
    for (const id of ["a", "b"]) cpSync(join(FIXTURES, "claude-transcript.jsonl"), join(dir, `${id}.jsonl`))

    const dataDir = freshDir("claude-backfill-dry-data")
    await install(dataDir, ["--global"])
    const before = gateway.calls.presign.length
    const res = await runCli(["backfill", "--dry-run"], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url, HOME: home, USERPROFILE: home },
    })
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /2/, "must report how much it is about to publish")
    assert.equal(gateway.calls.presign.length, before, "--dry-run must not publish anything")
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("--limit bounds a run, and re-running continues where it stopped", async () => {
    const home = freshDir("claude-backfill-resume")
    const dir = join(home, ".claude", "projects", "-tmp-repo")
    mkdirSync(dir, { recursive: true })
    for (const id of ["r1", "r2", "r3"]) cpSync(join(FIXTURES, "claude-transcript.jsonl"), join(dir, `${id}.jsonl`))

    const dataDir = freshDir("claude-backfill-resume-data")
    await install(dataDir, ["--global"])
    const env = {
      CLAUDE_PLUGIN_DATA: dataDir,
      BONEZ_GATEWAY_URL: gateway.url,
      HOME: home,
      USERPROFILE: home,
      BONEZ_SESSION_SYNC_DEBOUNCE_MS: "0",
    }

    const before = gateway.calls.presign.length
    assert.equal((await runCli(["backfill", "--limit=2"], { env })).status, 0)
    assert.equal(gateway.calls.presign.length - before, 2, "--limit must bound the batch")

    // The interrupt-safety property: what already uploaded is recorded, so a second run picks
    // up only the remainder rather than starting over.
    assert.equal((await runCli(["backfill"], { env })).status, 0)
    assert.equal(gateway.calls.presign.length - before, 3, "the resumed run uploads only what was left")

    assert.equal((await runCli(["backfill"], { env })).status, 0)
    assert.equal(gateway.calls.presign.length - before, 3, "a third run has nothing left to do")
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("backfill refuses to run when capture is not installed", async () => {
    const home = freshDir("claude-backfill-noinstall")
    const dataDir = freshDir("claude-backfill-noinstall-data")
    const res = await runCli(["backfill"], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url, HOME: home, USERPROFILE: home },
    })
    assert.equal(res.status, 1, "must not silently do nothing — publishing needs a credential")
    rmSync(home, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })
})

// ------------------------------------------------------------------ foreign gateway guard

describe("login / install refuse a gateway Bonez does not operate", () => {
  // The bug this guards: session capture signs in against Bonez's own identity provider and
  // uploads to Bonez's own pipeline. A user whose plugin points at a customer's Bonez server
  // (BONEZ_MCP_URL / BONEZ_GATEWAY_URL) must never end up shipping transcripts to ours by
  // running `login` out of habit. BONEZ_OAUTH_CLIENT_ID is blanked so that even a regressed
  // guard fails fast on an assertion rather than starting a real device flow.
  const guarded = (extra) => ({ BONEZ_OAUTH_CLIENT_ID: "", ...extra })

  for (const [label, env] of [
    ["BONEZ_GATEWAY_URL", { BONEZ_GATEWAY_URL: "https://bonez.example.com" }],
    ["BONEZ_MCP_URL", { BONEZ_MCP_URL: "https://bonez.example.com/mcp" }],
    ["Claude plugin option", { CLAUDE_PLUGIN_OPTION_BONEZ_URL: "https://bonez.example.com", BONEZ_GATEWAY_URL: "https://gateway.bonez.io" }],
  ]) {
    test(`install refuses a customer box set via ${label}, and writes nothing`, async () => {
      const dataDir = freshDir("guard-install")
      const res = await runCli(["install", TEST_KEY, "--global"], { env: guarded({ CLAUDE_PLUGIN_DATA: dataDir, ...env }) })
      assert.equal(res.status, 1)
      assert.match(res.stderr, /refusing `install`.*bonez\.example\.com/s)
      assert.equal(existsSync(join(dataDir, "config.json")), false)
      rmSync(dataDir, { recursive: true, force: true })
    })

    test(`login refuses a customer box set via ${label}, before any sign-in`, async () => {
      const dataDir = freshDir("guard-login")
      const res = await runCli(["login", "--global"], { env: guarded({ CLAUDE_PLUGIN_DATA: dataDir, ...env }) })
      assert.equal(res.status, 1)
      assert.match(res.stderr, /refusing `login`.*bonez\.example\.com/s)
      assert.doesNotMatch(res.stderr, /install <bnz_/, "must refuse on the host, not fall through to the missing-client path")
      assert.equal(existsSync(join(dataDir, "config.json")), false)
      rmSync(dataDir, { recursive: true, force: true })
    })
  }

  test("look-alike hosts are refused: the match is on the exact host", async () => {
    for (const url of [
      "https://gateway.bonez.io.evil.example",
      "https://evilgateway.bonez.io",
      "https://console.bonez.io",
      "not a url",
    ]) {
      const dataDir = freshDir("guard-lookalike")
      const res = await runCli(["install", TEST_KEY, "--global"], { env: guarded({ CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: url }) })
      assert.equal(res.status, 1, `${url} must be refused`)
      assert.equal(existsSync(join(dataDir, "config.json")), false)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test("our own gateways and loopback still install: prod (default), qa, and a local gateway", async () => {
    for (const env of [
      {},
      { BONEZ_GATEWAY_URL: "https://qa.gateway.bonez.io" },
      { BONEZ_MCP_URL: "https://GATEWAY.bonez.io:443/mcp" },
      { BONEZ_GATEWAY_URL: "http://127.0.0.1:8080" },
      { BONEZ_GATEWAY_URL: "http://localhost:8080" },
    ]) {
      const dataDir = freshDir("guard-allowed")
      const res = await runCli(["install", TEST_KEY, "--global"], { env: guarded({ CLAUDE_PLUGIN_DATA: dataDir, ...env }) })
      assert.equal(res.status, 0, `${JSON.stringify(env)} must be allowed: ${res.stderr}`)
      assert.equal(existsSync(join(dataDir, "config.json")), true)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------------------- credential store location

describe("credential store: one sign-in shared by all three clients", () => {
  // The bug this guards: the store used to be `CLAUDE_PLUGIN_DATA || <hardcoded ~/.claude
  // path>`. Cursor sets CLAUDE_PROJECT_DIR but NOT CLAUDE_PLUGIN_DATA, so it always took the
  // hardcoded branch — while Claude Code writes to `<plugin>-<marketplace>`, which is only
  // that same path when the marketplace happens to be named "bonez". Any other name and
  // Cursor silently found no credential and captured nothing, with no error anywhere.
  const statusDataDir = (out) => (/hook reads:\s*(.+?)(?: \(|$)/m.exec(out)?.[1] ?? "").trim()

  test("a fresh install with no legacy store lands in the agent-neutral location", async () => {
    const home = freshDir("store-fresh")
    const res = await runCli(["install", TEST_KEY, "--global"], {
      env: { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: "", BONEZ_SESSION_SYNC_DATA: "" },
    })
    assert.equal(res.status, 0, res.stderr)
    const st = await runCli(["status"], {
      env: { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: "", BONEZ_SESSION_SYNC_DATA: "" },
    })
    assert.match(statusDataDir(st.stdout), /\.bonez[\\/]session-sync$/)
    assert.doesNotMatch(st.stdout, /\.claude/, "a Cursor-only user must not get a ~/.claude directory")
    rmSync(home, { recursive: true, force: true })
  })

  test("an existing legacy store keeps working — a path change must never orphan a credential", async () => {
    const home = freshDir("store-legacy")
    const legacy = join(home, ".claude", "plugins", "data", "bonez-bonez")
    mkdirSync(legacy, { recursive: true })
    writeFileSync(
      join(legacy, "config.json"),
      JSON.stringify({ enabled: true, scope: "global", repos: [], apiKey: TEST_KEY, installedAt: "2026-08-25T00:00:00Z" }),
    )
    const env = { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: "", BONEZ_SESSION_SYNC_DATA: "" }

    // `status` migrates, then reports the NEW location — but the credential survives either way.
    const st = await runCli(["status"], { env })
    assert.match(st.stdout, /enabled/, "the legacy credential must still be found")
    assert.match(st.stdout, /Moved your session-capture credential/)
    assert.match(statusDataDir(st.stdout), /\.bonez[\\/]session-sync$/)

    // The legacy copy stays put: an older build of this script may still be reading it.
    assert.ok(existsSync(join(legacy, "config.json")), "legacy config must not be deleted")
    assert.ok(existsSync(join(home, ".bonez", "session-sync", "config.json")), "migrated copy must exist")
    rmSync(home, { recursive: true, force: true })
  })

  test("the actual bug: Claude Code writes under a non-'bonez' marketplace, Cursor still finds it", async () => {
    const home = freshDir("store-split")
    // Claude Code's data dir is <plugin>-<marketplace>; here the marketplace is "acme".
    const claudeDir = join(home, ".claude", "plugins", "data", "bonez-acme")
    mkdirSync(claudeDir, { recursive: true })
    const claudeEnv = { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: claudeDir, BONEZ_SESSION_SYNC_DATA: "" }
    assert.equal((await runCli(["install", TEST_KEY, "--global"], { env: claudeEnv })).status, 0)

    // Cursor's environment: no CLAUDE_PLUGIN_DATA at all.
    const cursorEnv = { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: "", BONEZ_SESSION_SYNC_DATA: "" }
    const st = await runCli(["status"], { env: cursorEnv })
    assert.match(st.stdout, /enabled/, "Cursor must find the credential Claude Code wrote — this is the regression")
    rmSync(home, { recursive: true, force: true })
  })

  test("CLAUDE_PLUGIN_DATA still wins when set, so existing Claude Code installs are untouched", async () => {
    const home = freshDir("store-override")
    const explicit = join(home, "explicit-store")
    const env = { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: explicit, BONEZ_SESSION_SYNC_DATA: "" }
    assert.equal((await runCli(["install", TEST_KEY, "--global"], { env })).status, 0)
    const st = await runCli(["status"], { env })
    assert.equal(statusDataDir(st.stdout), explicit)
    rmSync(home, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------- cursor leg

describe("_upload — Cursor leg against the stub gateway", () => {
  test("sessionEnd: agent=cursor in the manifest, roles read off the OUTER record, secret redacted", async () => {
    const dataDir = freshDir("cursor-upload")
    await install(dataDir, ["--global"])
    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(
      payloadFile,
      JSON.stringify({
        hook_event_name: "sessionEnd",
        conversation_id: "cursor-transcript",
        session_id: "some-other-session-id",
        reason: "completed",
        workspace_roots: ["/tmp/bonez-session-sync-fixture-repo"],
        transcript_path: join(FIXTURES, "cursor-transcript.jsonl"),
      }),
    )
    const res = await runCli(["_upload", "cursor", "session-end", payloadFile], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url },
    })
    assert.equal(res.status, 0)

    const putCall = gateway.calls.put.at(-1)
    const [manifest, conversation] = ndjsonLinesFromGzip(putCall.body)
    assert.deepEqual(manifest.agents, ["cursor"])
    assert.equal(conversation.agent, "cursor")

    // The presign call must declare the same agent — the gateway validates it against its own
    // allow-list (_AGENTS in control/import_presign.py), so a mismatch here 400s in prod.
    assert.equal(gateway.calls.presign.at(-1).body.agent, "cursor")

    // The whole reason parseClaudeFile can't be reused: Cursor puts `role` on the outer record,
    // so a Claude-shaped read labels EVERY message "user". Assert the real split.
    const roles = conversation.messages.map((m) => m.role)
    assert.ok(roles.includes("user"), "user turns preserved")
    assert.ok(roles.includes("assistant"), "assistant turns must NOT collapse into 'user'")
    assert.ok(roles.includes("tool"), "tool_use blocks become tool messages")

    // tool_use and tool_result both land, and the result is linked to its call.
    const call = conversation.messages.find((m) => m.tool === "Grep")
    assert.ok(call, "the tool_use block became a tool message")
    assert.equal(call.toolCallId, "toolu_01")
    const result = conversation.messages.find((m) => m.tool === "result")
    assert.ok(result, "the tool_result block became a result message")
    assert.equal(result.toolResultFor, "toolu_01")

    // Envelope fields Cursor's records omit, recovered from the payload and the file.
    assert.equal(conversation.workspacePath, "/tmp/bonez-session-sync-fixture-repo")
    assert.equal(conversation.title, "Why does the checkout retry twice?")
    assert.ok(conversation.createdAt, "createdAt stands in from the file's birthtime")
    assert.ok(conversation.updatedAt, "updatedAt stands in from the file's mtime")

    // unit_key: the CONVERSATION id, not sessionEnd's session_id — that's what the transcript
    // is filed under and what survives a resume.
    assert.equal(conversation.sessionId, "cursor-transcript")

    const raw = JSON.stringify(conversation)
    assert.ok(!raw.includes(FAKE_GITHUB_TOKEN))
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("no transcript_path in the payload: falls back to CURSOR_TRANSCRIPT_PATH, then to a walk of ~/.cursor/projects", async () => {
    const fakeHome = freshDir("cursor-home")
    const convoId = "cursor-transcript"
    const dir = join(fakeHome, ".cursor", "projects", "Users-someone-repo", "agent-transcripts", convoId)
    mkdirSync(dir, { recursive: true })
    cpSync(join(FIXTURES, "cursor-transcript.jsonl"), join(dir, `${convoId}.jsonl`))

    const dataDir = freshDir("cursor-walk")
    await install(dataDir, ["--global"])
    const payloadFile = join(dataDir, "payload.json")
    // transcript_path deliberately absent — Cursor documents it as nullable.
    writeFileSync(payloadFile, JSON.stringify({ hook_event_name: "sessionEnd", conversation_id: convoId }))

    const before = gateway.calls.presign.length
    const res = await runCli(["_upload", "cursor", "session-end", payloadFile], {
      env: {
        CLAUDE_PLUGIN_DATA: dataDir,
        BONEZ_GATEWAY_URL: gateway.url,
        HOME: fakeHome,
        CURSOR_PROJECT_DIR: "/tmp/bonez-session-sync-fixture-repo",
      },
    })
    assert.equal(res.status, 0)
    assert.equal(gateway.calls.presign.length, before + 1, "resolved the transcript from disk and uploaded")

    const [, conversation] = ndjsonLinesFromGzip(gateway.calls.put.at(-1).body)
    // CURSOR_PROJECT_DIR is the documented always-present fallback for the workspace root.
    assert.equal(conversation.workspacePath, "/tmp/bonez-session-sync-fixture-repo")

    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("repo scope: a Cursor conversation outside the allow-listed repos is not uploaded", async () => {
    const dataDir = freshDir("cursor-scope")
    // Scope to a repo the payload's workspace root is NOT under.
    await install(dataDir, ["--repo", "/tmp/some-other-repo"])
    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(
      payloadFile,
      JSON.stringify({
        hook_event_name: "sessionEnd",
        conversation_id: "cursor-transcript",
        workspace_roots: ["/tmp/not-the-allow-listed-one"],
        transcript_path: join(FIXTURES, "cursor-transcript.jsonl"),
      }),
    )
    const before = gateway.calls.presign.length
    const res = await runCli(["_upload", "cursor", "session-end", payloadFile], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url },
    })
    assert.equal(res.status, 0)
    assert.equal(gateway.calls.presign.length, before, "out-of-scope conversation must not upload")
    rmSync(dataDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------- real transcript

describe("real transcript from ~/.cursor/projects/", () => {
  test("a genuine Cursor transcript parses with a real role split and a non-empty title", async () => {
    const projects = join(process.env.HOME, ".cursor", "projects")
    let found
    try {
      for (const d of readdirSync(projects, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const at = join(projects, d.name, "agent-transcripts")
        if (!existsSync(at)) continue
        for (const c of readdirSync(at, { withFileTypes: true })) {
          if (!c.isDirectory()) continue
          const f = join(at, c.name, `${c.name}.jsonl`)
          // Skip the degenerate giants: Cursor inlines whole websearch payloads into a single
          // record, and some transcripts run to tens of MB. Nothing here needs a big one.
          if (existsSync(f) && statSync(f).size > 2_000 && statSync(f).size < 2_000_000) {
            found = f
            break
          }
        }
        if (found) break
      }
    } catch {
      /* no ~/.cursor at all on this machine */
    }
    if (!found) {
      // Not a failure: CI runners have no Cursor history. The fixture-based tests above are the
      // real contract; this one is an extra check against the format actually on disk today.
      return
    }

    const mod = await import("../bin/bonez-session-sync.mjs")
    const { Scrubber } = await import("../bin/vendor/agent-import.bundle.mjs")
    const conv = mod.parseCursorFile(found, new Scrubber(), [], "global", "/tmp/whatever")
    assert.ok(conv, `parseCursorFile returned null for a real transcript: ${found}`)
    assert.equal(conv.agent, "cursor")
    assert.ok(conv.messages.length > 0)
    const roles = new Set(conv.messages.map((m) => m.role))
    assert.ok(roles.has("assistant"), `every role collapsed to ${[...roles]} — the outer-record role read regressed`)
    assert.ok(conv.sessionId && conv.sessionId !== found, "sessionId is the conversation id, not the path")
  })
})

describe("real transcript from ~/.claude/projects/", () => {
  test("a genuine transcript, copied and salted with a planted secret, uploads with the secret redacted", async () => {
    const projectsDir = join(process.env.HOME, ".claude", "projects")
    let glob = []
    try {
      glob = readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => {
          const dir = join(projectsDir, d.name)
          try {
            return readdirSync(dir)
              .filter((f) => f.endsWith(".jsonl"))
              .map((f) => join(dir, f))
          } catch {
            return []
          }
        })
    } catch {
      glob = []
    }
    // Environment-dependent: skip gracefully if this machine has no real Claude Code history.
    if (glob.length === 0) {
      console.log("  (skipped — no ~/.claude/projects/**/*.jsonl found on this machine)")
      return
    }
    const real = glob.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]

    const dataDir = freshDir("real-transcript")
    await install(dataDir, ["--global"])
    const copy = join(dataDir, "real-copy.jsonl")
    cpSync(real, copy)
    const secret = ["sk", "live", "ZZZZYYYYXXXXWWWWVVVVUUUU"].join("_")
    writeFileSync(
      copy,
      `${readFileSync(copy, "utf8")}\n{"type":"user","timestamp":"2026-08-24T12:00:00.000Z","message":{"role":"user","content":"planted for the test — do not use: ${secret}"}}\n`,
    )
    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(payloadFile, JSON.stringify({ session_id: "real-transcript-copy", transcript_path: copy }))

    const res = await runCli(["_upload", "claude", "session-end", payloadFile], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url },
    })
    assert.equal(res.status, 0)
    const putCall = gateway.calls.put.at(-1)
    const [, conversation] = ndjsonLinesFromGzip(putCall.body)
    const raw = JSON.stringify(conversation)
    assert.doesNotMatch(raw, new RegExp(secret))
    assert.ok(conversation.messages.length > 0)

    rmSync(dataDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------- hook fast path

describe("hook — wall time and invisibility", () => {
  test("hook claude session-end: fast, silent, exit 0, and really spawns the background upload", async () => {
    const dataDir = freshDir("hook-claude")
    await install(dataDir, ["--global"])
    const res = await runCli(["hook", "claude", "session-end"], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url },
      input: JSON.stringify({
        session_id: "hook-fast-path",
        transcript_path: join(FIXTURES, "claude-transcript.jsonl"),
        cwd: "/tmp/bonez-session-sync-fixture-repo",
        hook_event_name: "SessionEnd",
        reason: "other",
      }),
    })
    assert.equal(res.status, 0)
    assert.equal(res.stdout, "")
    assert.equal(res.stderr, "")
    assert.ok(res.ms < 500, `hook wall time was ${res.ms.toFixed(1)}ms — expected comfortably under Claude Code's 1.5s SessionEnd budget`)

    // The local dedup key is the parsed conversation's own sessionId — for Claude that's the
    // transcript FILE's basename (here, the fixture's "claude-transcript"), which happens to
    // differ from the "hook-fast-path" id this payload uses (a real hook's transcript_path and
    // session_id always agree; this fixture is reused as-is across tests for its content, not
    // its filename).
    await waitFor(() => {
      // The background writer is a separate process; a poll can catch sync-state.json between
      // its open() and write() (a torn read), so a parse failure here means "not ready yet",
      // not "broken" — keep polling instead of throwing.
      if (!existsSync(join(dataDir, "sync-state.json"))) return false
      try {
        return JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf8"))["claude-transcript"]
      } catch {
        return false
      }
    })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("hook cursor session-end: fast, silent, exit 0, and really spawns the background upload", async () => {
    const dataDir = freshDir("hook-cursor")
    await install(dataDir, ["--global"])
    const res = await runCli(["hook", "cursor", "session-end"], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url },
      input: JSON.stringify({
        hook_event_name: "sessionEnd",
        conversation_id: "cursor-transcript",
        session_id: "cursor-session-id",
        reason: "completed",
        duration_ms: 45000,
        workspace_roots: ["/tmp/bonez-session-sync-fixture-repo"],
        transcript_path: join(FIXTURES, "cursor-transcript.jsonl"),
      }),
    })
    assert.equal(res.status, 0)
    assert.equal(res.stdout, "")
    assert.equal(res.stderr, "")
    assert.ok(res.ms < 500, `hook wall time was ${res.ms.toFixed(1)}ms`)

    await waitFor(() => {
      if (!existsSync(join(dataDir, "sync-state.json"))) return false
      try {
        return JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf8"))["cursor-transcript"]
      } catch {
        return false
      }
    })
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("hook codex session-end: fast, silent, exit 0", async () => {
    const dataDir = freshDir("hook-codex")
    await install(dataDir, ["--global"])
    const res = await runCli(["hook", "codex", "session-end"], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url },
      input: JSON.stringify({
        session_id: "hook-fast-path-codex",
        turn_id: "t1",
        cwd: "/tmp/x",
        transcript_path: join(FIXTURES, "codex-rollout.jsonl"),
      }),
    })
    assert.equal(res.status, 0)
    assert.equal(res.stdout, "")
    assert.equal(res.stderr, "")
    assert.ok(res.ms < 1000, `hook wall time was ${res.ms.toFixed(1)}ms — expected comfortably under Codex's 1s default / 3s hard-max SessionEnd budget`)
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("never prints, never fails, regardless of what goes wrong", async () => {
    const dataDir = freshDir("hook-invisible")

    // Not installed at all.
    let res = await runCli(["hook", "claude", "session-end"], { env: { CLAUDE_PLUGIN_DATA: dataDir }, input: "{}" })
    assert.deepEqual([res.status, res.stdout, res.stderr], [0, "", ""])

    await install(dataDir, ["--global"])

    // Garbage stdin.
    res = await runCli(["hook", "claude", "session-end"], { env: { CLAUDE_PLUGIN_DATA: dataDir }, input: "not json at all {{{" })
    assert.deepEqual([res.status, res.stdout, res.stderr], [0, "", ""])

    // No stdin at all.
    res = await runCli(["hook", "claude", "session-end"], { env: { CLAUDE_PLUGIN_DATA: dataDir }, input: "" })
    assert.deepEqual([res.status, res.stdout, res.stderr], [0, "", ""])

    // Kill switch.
    res = await runCli(["hook", "claude", "session-end"], {
      env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_SESSION_SYNC: "0" },
      input: JSON.stringify({ session_id: "x", transcript_path: join(FIXTURES, "claude-transcript.jsonl") }),
    })
    assert.deepEqual([res.status, res.stdout, res.stderr], [0, "", ""])

    // Unknown agent/event.
    res = await runCli(["hook", "not-an-agent", "session-end"], { env: { CLAUDE_PLUGIN_DATA: dataDir }, input: "{}" })
    assert.deepEqual([res.status, res.stdout, res.stderr], [0, "", ""])

    rmSync(dataDir, { recursive: true, force: true })
  })
})

test("an empty host data directory uses the configured shared store, while a host opt-out wins", async () => {
  const home = freshDir("shared-login")
  const host = join(home, "empty-host")
  const shared = join(home, ".bonez", "session-sync")
  mkdirSync(host, { recursive: true })
  const env = { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: host, BONEZ_SESSION_SYNC_DATA: "" }
  try {
    assert.equal((await runCli(["install", TEST_KEY, "--global"], {
      env: { ...env, CLAUDE_PLUGIN_DATA: "" },
    })).status, 0)
    assert.ok((await runCli(["status"], { env })).stdout.includes(shared))
    writeFileSync(join(host, "config.json"), JSON.stringify({ enabled: false }))
    assert.match((await runCli(["status"], { env })).stdout, /disabled/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------- live session (1SI-3763)

describe("live session: start once, then repository-relative reads and edits", () => {
  // A Git checkout whose origin is acme/api, with two files in it and one file outside it.
  const makeRepo = (origin = "https://github.com/acme/api.git") => {
    const repo = freshDir("live-repo")
    for (const args of [["init", "-q"], ["remote", "add", "origin", origin]]) {
      assert.equal(spawnSync("git", args, { cwd: repo }).status, 0)
    }
    mkdirSync(join(repo, "src"))
    writeFileSync(join(repo, "src", "a.py"), "a = 1\n")
    writeFileSync(join(repo, "src", "b.py"), "b = 1\n")
    const outside = join(freshDir("live-outside"), "notes.txt")
    writeFileSync(outside, "private\n")
    return { repo, outside }
  }
  const forId = (route, id) => gateway.calls[route].filter((c) => c.headers["x-bonez-session"] === id)
  const logOf = (dataDir) => (existsSync(join(dataDir, "sync.log")) ? readFileSync(join(dataDir, "sync.log"), "utf8") : "")
  const hook = (dataDir, agent, event, payload) =>
    runCli(["hook", agent, event], { env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url }, input: JSON.stringify(payload) })
  // The start worker has finished once its catch-up line is logged (announce runs before it).
  const started = (dataDir, agent) => waitFor(() => logOf(dataDir).includes(`upload: ${agent} session-start`))
  // The drain worker has finished once its lock is gone and nothing is left spooled.
  const drained = (dataDir, id) => waitFor(() => !existsSync(join(dataDir, "presence", `${id}.lock`)) &&
    !existsSync(join(dataDir, "presence", `${id}.ndjson`)))

  test("claude: one start with the header, the repository and no title; a read and an edit; nothing for a file outside", async () => {
    const { repo, outside } = makeRepo()
    const dataDir = freshDir("live-claude")
    await install(dataDir, ["--repo", repo])
    const id = "live-claude-1"
    const start = { hook_event_name: "SessionStart", session_id: id, cwd: repo, source: "startup" }
    await hook(dataDir, "claude", "session-start", start)
    await started(dataDir, "claude")
    await hook(dataDir, "claude", "session-start", { ...start, source: "resume" })
    await waitFor(() => logOf(dataDir).split("upload: claude session-start").length === 3)

    const starts = forId("start", id)
    assert.equal(starts.length, 1)
    assert.deepEqual(starts[0].body, { surface: "claude-code", repo: "acme/api" })
    assert.equal(starts[0].headers.authorization, `Bearer ${TEST_KEY}`)

    const touch = (tool_name, file_path) =>
      hook(dataDir, "claude", "tool-use", { hook_event_name: "PostToolUse", session_id: id, cwd: repo, tool_name, tool_input: { file_path, content: "SECRET" } })
    symlinkSync(outside, join(repo, "src", "link.txt"))
    const escapes = [["Read", outside], ["Read", join(repo, "src", "link.txt")], ["Edit", "src/../../escape.py"], ["Read", join(repo, "..", "x.py")]]
    for (const [tool, file] of [["Read", join(repo, "src", "a.py")], ["Edit", "src/b.py"], ...escapes]) {
      const res = await touch(tool, file)
      assert.equal(res.status, 0)
      assert.equal(res.stdout, "")
      assert.equal(res.stderr, "")
      assert.ok(res.ms < 500, `hook wall time was ${res.ms.toFixed(1)}ms`)
    }
    await waitFor(() => forId("events", id).length)
    await drained(dataDir, id)
    const events = forId("events", id).flatMap((c) => c.body.events)
    assert.deepEqual(events.map((e) => [e.tool, e.args]), [["read", { path: "acme/api/src/a.py" }], ["edit", { path: "acme/api/src/b.py" }]])
    assert.ok(events.every((e) => !Number.isNaN(Date.parse(e.at))))
    assert.doesNotMatch(JSON.stringify(forId("events", id)), /SECRET|private|notes\.txt/)
  })

  test("cursor: start with surface cursor and the conversation id; a relative edit resolves against the workspace", async () => {
    const { repo } = makeRepo()
    const dataDir = freshDir("live-cursor")
    await install(dataDir, ["--global"])
    const id = "live-cursor-convo"
    await hook(dataDir, "cursor", "session-start", { hook_event_name: "sessionStart", conversation_id: id, session_id: "other", workspace_roots: [repo] })
    await started(dataDir, "cursor")
    assert.deepEqual(forId("start", id).map((c) => c.body), [{ surface: "cursor", repo: "acme/api" }])
    await hook(dataDir, "cursor", "tool-use", { hook_event_name: "postToolUse", conversation_id: id, workspace_roots: [repo], tool_name: "Write", tool_input: { file_path: "src/a.py" } })
    await waitFor(() => forId("events", id).length)
    assert.deepEqual(forId("events", id)[0].body.events.map((e) => [e.tool, e.args.path]), [["write", "acme/api/src/a.py"]])
  })

  test("capture off, or the repository out of scope: nothing is sent", async () => {
    const { repo } = makeRepo()
    const off = freshDir("live-off")
    await install(off, ["--global"])
    assert.equal((await runCli(["disable"], { env: { CLAUDE_PLUGIN_DATA: off } })).status, 0)
    const elsewhere = freshDir("live-scope")
    await install(elsewhere, ["--repo", freshDir("live-other-repo")])

    for (const [dataDir, id] of [[off, "live-off-1"], [elsewhere, "live-scope-1"]]) {
      await hook(dataDir, "claude", "session-start", { hook_event_name: "SessionStart", session_id: id, cwd: repo })
      await hook(dataDir, "claude", "tool-use", { hook_event_name: "PostToolUse", session_id: id, cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "src", "a.py") } })
    }
    await started(elsewhere, "claude") // the disabled install never spawns a worker at all
    await new Promise((r) => setTimeout(r, 1500)) // longer than a drain's batch wait
    for (const id of ["live-off-1", "live-scope-1"]) {
      assert.equal(forId("start", id).length, 0, id)
      assert.equal(forId("events", id).length, 0, id)
    }
    assert.ok(!existsSync(join(off, "presence")) && !existsSync(join(elsewhere, "presence")))
  })

  test("a 403 on start (an older gateway) stops every further call for that session", async () => {
    const { repo } = makeRepo()
    const dataDir = freshDir("live-403")
    await install(dataDir, ["--global"])
    const id = "live-403-1"
    gateway.answers.start = 403
    try {
      await hook(dataDir, "claude", "session-start", { hook_event_name: "SessionStart", session_id: id, cwd: repo })
      await started(dataDir, "claude")
    } finally {
      gateway.answers.start = 200
    }
    assert.equal(forId("start", id).length, 1)
    assert.match(logOf(dataDir), /presence: start session=live-403-1 agent=claude failed — HTTP 403/)
    await hook(dataDir, "claude", "tool-use", { hook_event_name: "PostToolUse", session_id: id, cwd: repo, tool_name: "Read", tool_input: { file_path: join(repo, "src", "a.py") } })
    await hook(dataDir, "claude", "session-start", { hook_event_name: "SessionStart", session_id: id, cwd: repo, source: "resume" })
    await waitFor(() => logOf(dataDir).split("upload: claude session-start").length === 3)
    await new Promise((r) => setTimeout(r, 1500))
    assert.equal(forId("start", id).length, 1)
    assert.equal(forId("events", id).length, 0)
  })

  const recall = (dataDir, host, payload) => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "bin", "bonez-recall-hook.mjs"), host], {
      encoding: "utf8", input: JSON.stringify(payload),
      env: { ...process.env, HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME, BONEZ_SESSION_SYNC_DATA: dataDir },
    })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    return host === "cursor" ? out.additional_context : out.hookSpecificOutput.additionalContext
  }

  test("outside a Git checkout: global scope announces with no repository; repo scope does not, and says why", async () => {
    const folder = freshDir("live-workspace-root") // a folder of several repositories, not one itself
    writeFileSync(join(folder, "notes.md"), "x\n")
    const global = freshDir("live-noscope-global")
    await install(global, ["--global"])
    const id = "live-norepo-1"
    await hook(global, "claude", "session-start", { hook_event_name: "SessionStart", session_id: id, cwd: folder })
    await started(global, "claude")
    assert.deepEqual(forId("start", id).map((c) => c.body), [{ surface: "claude-code" }])
    assert.deepEqual(JSON.parse(readFileSync(join(global, "presence", `${id}.json`), "utf8")), { repo: null })
    // No repository to be relative to, so file touches are not sent.
    await hook(global, "claude", "tool-use", { hook_event_name: "PostToolUse", session_id: id, cwd: folder, tool_name: "Edit", tool_input: { file_path: join(folder, "notes.md") } })
    await new Promise((r) => setTimeout(r, 1500))
    assert.equal(forId("events", id).length, 0)

    const scoped = freshDir("live-noscope-repo")
    await install(scoped, ["--repo", freshDir("live-listed-repo")])
    await hook(scoped, "claude", "session-start", { hook_event_name: "SessionStart", session_id: "live-norepo-2", cwd: folder })
    await started(scoped, "claude")
    assert.equal(forId("start", "live-norepo-2").length, 0)
    assert.match(logOf(scoped), /presence: start session=live-norepo-2 agent=claude not announced — the folder is outside the capture scope/)
  })

  test("recall text names the session only once its start succeeded; otherwise it is unchanged", async () => {
    const { repo } = makeRepo()
    const dataDir = freshDir("live-recall")
    await install(dataDir, ["--global"])
    const cases = [
      ["claude", { hook_event_name: "SessionStart", session_id: "live-recall-1", cwd: repo }],
      ["claude", { hook_event_name: "PostToolUse", session_id: "live-recall-1", cwd: repo, tool_name: "Read", tool_input: { file_path: join(repo, "src", "a.py") } }],
      ["cursor", { hook_event_name: "postToolUse", conversation_id: "live-recall-1", workspace_roots: [repo], tool_name: "Edit", tool_input: { file_path: join(repo, "src", "a.py") } }],
    ]
    const before = cases.map(([host, payload]) => recall(dataDir, host, payload))
    for (const text of before) assert.doesNotMatch(text, /live-recall-1|"session"/)
    gateway.answers.start = 403
    try {
      await hook(dataDir, "claude", "session-start", cases[0][1])
      await started(dataDir, "claude")
    } finally {
      gateway.answers.start = 200
    }
    assert.deepEqual(cases.map(([host, payload]) => recall(dataDir, host, payload)), before, "a refused start keeps the text")

    rmSync(join(dataDir, "presence"), { recursive: true, force: true })
    await hook(dataDir, "claude", "session-start", { ...cases[0][1], source: "resume" })
    await waitFor(() => existsSync(join(dataDir, "presence", "live-recall-1.json")))
    const note = ' This session\'s id is "live-recall-1". Pass "session": "live-recall-1" to every memory_recall call. An Active sessions row or session_activity that carries this id is this session itself, not overlapping work.'
    assert.deepEqual(cases.map(([host, payload]) => recall(dataDir, host, payload)), before.map((t) => t + note))
    // Codex is never announced, so its text never changes.
    const codex = { hook_event_name: "SessionStart", session_id: "live-recall-1", cwd: repo }
    assert.doesNotMatch(recall(dataDir, "codex", codex), /live-recall-1/)
  })

  test("a 404 or 409 on events refuses the session: one failed call, not one per burst", async () => {
    for (const status of [404, 409]) {
      const { repo } = makeRepo()
      const dataDir = freshDir(`live-${status}`)
      await install(dataDir, ["--global"])
      const id = `live-events-${status}`
      await hook(dataDir, "claude", "session-start", { hook_event_name: "SessionStart", session_id: id, cwd: repo })
      await started(dataDir, "claude")
      gateway.answers.events = status
      try {
        const touch = () => hook(dataDir, "claude", "tool-use", { hook_event_name: "PostToolUse", session_id: id, cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "src", "a.py") } })
        await touch()
        await waitFor(() => forId("events", id).length)
        await drained(dataDir, id)
        await touch()
        await new Promise((r) => setTimeout(r, 1500))
      } finally {
        gateway.answers.events = 200
      }
      assert.equal(forId("events", id).length, 1, String(status))
      assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "presence", `${id}.json`), "utf8")), { refused: status })
    }
  })

  test("origin: an ssh URL with a port gives owner/name; a URL with credentials sends no repository", async () => {
    const dataDir = freshDir("live-origin")
    await install(dataDir, ["--global"])
    for (const [origin, id, want] of [
      ["ssh://git@git.example.com:2222/acme/api.git", "live-origin-port", [{ surface: "claude-code", repo: "acme/api" }]],
      ["https://github.com:8443/acme/api.git", "live-origin-https-port", [{ surface: "claude-code", repo: "acme/api" }]],
      // The credentials never leave; the session is announced with no repository.
      ["https://someone:tok@github.com/acme/api.git", "live-origin-creds", [{ surface: "claude-code" }]],
    ]) {
      const { repo } = makeRepo(origin)
      const lines = logOf(dataDir).split("upload: claude session-start").length
      await hook(dataDir, "claude", "session-start", { hook_event_name: "SessionStart", session_id: id, cwd: repo })
      await waitFor(() => logOf(dataDir).split("upload: claude session-start").length > lines)
      assert.deepEqual(forId("start", id).map((c) => c.body), want, origin)
    }
  })

  test("a gateway Bonez does not operate gets neither call", async () => {
    const { repo } = makeRepo()
    const dataDir = freshDir("live-foreign")
    await install(dataDir, ["--global"])
    const fetchLog = join(dataDir, "fetch.log")
    writeFileSync(fetchLog, "")
    const env = {
      CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: "https://bonez.example.com",
      NODE_OPTIONS: `--import=${join(HERE, "lib", "record-fetch.mjs")}`, BONEZ_TEST_FETCH_LOG: fetchLog,
    }
    const id = "live-foreign-1"
    await runCli(["hook", "claude", "session-start"], { env, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd: repo }) })
    await started(dataDir, "claude")
    assert.ok(!existsSync(join(dataDir, "presence", `${id}.json`)))
    // An announced session whose gateway setting then changes: the drain worker refuses too.
    mkdirSync(join(dataDir, "presence"), { recursive: true })
    writeFileSync(join(dataDir, "presence", `${id}.json`), JSON.stringify({ repo: "acme/api", root: realpathSync(repo) }))
    await runCli(["hook", "claude", "tool-use"], { env, input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: id, cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "src", "a.py") } }) })
    await drained(dataDir, id)
    assert.equal(readFileSync(fetchLog, "utf8"), "")
  })

  test("the drain lock: one holder at a time, a stale one is taken over, two workers at once send each touch once", async () => {
    const dataDir = freshDir("live-lock")
    mkdirSync(join(dataDir, "presence"), { recursive: true })
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { utimesSync } from "node:fs"
      const { takePresenceLock } = await import(${JSON.stringify(SCRIPT)})
      const a = takePresenceLock("lk"), b = takePresenceLock("lk")
      const old = new Date(Date.now() - 120_000)
      utimesSync(${JSON.stringify(join(dataDir, "presence", "lk.lock"))}, old, old)
      console.log(JSON.stringify([a, b, takePresenceLock("lk")]))`], {
      encoding: "utf8", env: { ...process.env, HOME: SANDBOX_HOME, BONEZ_SESSION_SYNC_DATA: dataDir },
    })
    assert.deepEqual(JSON.parse(probe.stdout), [true, false, true], probe.stderr)

    await install(dataDir, ["--global"])
    const id = "live-lock-2"
    writeFileSync(join(dataDir, "presence", `${id}.json`), JSON.stringify({ repo: "acme/api", root: "/nowhere" }))
    const at = new Date().toISOString()
    writeFileSync(join(dataDir, "presence", `${id}.ndjson`),
      ["a", "b", "c"].map((f) => JSON.stringify({ tool: "edit", args: { path: `acme/api/${f}.py` }, at })).join("\n") + "\n")
    const env = { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url }
    await Promise.all([runCli(["_presence", id], { env }), runCli(["_presence", id], { env })])
    assert.deepEqual(forId("events", id).flatMap((c) => c.body.events.map((e) => e.args.path)).sort(),
      ["acme/api/a.py", "acme/api/b.py", "acme/api/c.py"])
  })

  test("session end forgets the session; session start sweeps presence files older than three days", async () => {
    const { repo } = makeRepo()
    const dataDir = freshDir("live-end")
    await install(dataDir, ["--global"])
    const id = "live-end-1"
    await hook(dataDir, "claude", "session-start", { hook_event_name: "SessionStart", session_id: id, cwd: repo })
    await waitFor(() => existsSync(join(dataDir, "presence", `${id}.json`)))
    const old = join(dataDir, "presence", "crashed-long-ago.json")
    writeFileSync(old, "{}")
    utimesSync(old, new Date(Date.now() - 4 * 86_400_000), new Date(Date.now() - 4 * 86_400_000))
    await hook(dataDir, "claude", "session-end", { hook_event_name: "SessionEnd", session_id: id, cwd: repo, transcript_path: join(FIXTURES, "claude-transcript.jsonl") })
    assert.ok(!existsSync(join(dataDir, "presence", `${id}.json`)))
    await hook(dataDir, "claude", "session-start", { hook_event_name: "SessionStart", session_id: "live-end-2", cwd: repo })
    await waitFor(() => existsSync(join(dataDir, "presence", "live-end-2.json")))
    assert.ok(!existsSync(old))
  })
})

// ---------------------------------------------------------------------------- capture says when it is off (1SI-3775)

describe("capture says when it is set up but not working", () => {
  const PERSON = /^\{"systemMessage":"Bonez session capture .*Run `node \\".*bonez-session-sync\.mjs\\" status` for details\."\}$/
  const homeWith = (prefix) => {
    const home = freshDir(prefix)
    return { home, env: { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: "", BONEZ_SESSION_SYNC_DATA: "", BONEZ_GATEWAY_URL: gateway.url } }
  }
  const start = (env, cwd = "/tmp/bonez-capture-health") =>
    runCli(["hook", "claude", "session-start"], { env, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "now", cwd, source: "startup" }) })
  const store = (home) => join(home, ".bonez", "session-sync")
  const readJsonOr = (path) => JSON.parse(readFileSync(path, "utf8"))
  const installed = async (home, env, extra = {}) => {
    mkdirSync(store(home), { recursive: true })
    writeFileSync(join(store(home), "config.json"), JSON.stringify({ enabled: true, scope: "global", repos: [], apiKey: TEST_KEY, installedAt: "2026-08-01T00:00:00Z", ...extra }))
  }

  test("status gives the same answer under the hook's environment and from a plain shell", async () => {
    const outputs = []
    for (const where of ["hook", "shell"]) {
      const { home, env } = homeWith(`status-${where}`)
      const hostDir = join(home, ".claude", "plugins", "data", "bonez-acme")
      const older = join(home, ".claude", "plugins", "data", "bonez-bonez")
      mkdirSync(hostDir, { recursive: true })
      mkdirSync(older, { recursive: true })
      writeFileSync(join(older, "config.json"), JSON.stringify({ enabled: true, scope: "global", repos: [], apiKey: TEST_KEY, installedAt: "2026-08-01T00:00:00Z" }))
      const hookEnv = { ...env, CLAUDE_PLUGIN_DATA: hostDir }
      await start(hookEnv) // the Claude Code hook writes down its folder
      const st = await runCli(["status"], { env: where === "hook" ? hookEnv : env })
      assert.equal(st.status, 0, st.stderr)
      outputs.push(st.stdout.replaceAll(home, "<home>"))
    }
    assert.equal(outputs[0], outputs[1])
    assert.match(outputs[0], /bonez session capture: enabled/)
    assert.match(outputs[0], /hook reads: <home>\/\.bonez\/session-sync \(settings found through the fallback; the Claude Code folder <home>\/\.claude\/plugins\/data\/bonez-acme has none\)/)
    assert.match(outputs[0], /last upload attempt: none recorded/)
    assert.match(outputs[0], /last successful upload: never/)
  })

  test("a failing call logs its cause, step and host, and no credential", async () => {
    const { home, env } = homeWith("cause")
    await installed(home, env, { apiKey: undefined, oauth: { accessToken: "at-SECRET-1", refreshToken: "rt-SECRET-2", expiresAt: Date.now() - 1 } })
    const payloadFile = join(home, "payload.json")
    writeFileSync(payloadFile, JSON.stringify({ session_id: "s", transcript_path: join(FIXTURES, "claude-transcript.jsonl"), cwd: "/tmp/x" }))
    const closed = await new Promise((r) => { const srv = createServer().listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => r(port)) }) })
    const res = await runCli(["_upload", "claude", "session-end", payloadFile], { env: { ...env, BONEZ_GATEWAY_URL: `http://127.0.0.1:${closed}` } })
    assert.equal(res.stdout, "")
    const log = readFileSync(join(store(home), "sync.log"), "utf8")
    assert.match(log, new RegExp(`token refresh to 127\\.0\\.0\\.1:${closed} failed — ECONNREFUSED: connect ECONNREFUSED 127\\.0\\.0\\.1:${closed}`))
    assert.doesNotMatch(log, /SECRET/)
    const st = await runCli(["status"], { env })
    assert.match(st.stdout, new RegExp(`last upload attempt: .* — failed: token refresh to 127\\.0\\.0\\.1:${closed}: ECONNREFUSED`))
    assert.doesNotMatch(st.stdout, /SECRET/)

    const mod = await import("../bin/bonez-session-sync.mjs")
    const tls = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) })
    assert.deepEqual(mod.describeFailure("token refresh", "gateway.bonez.io", tls), {
      step: "token refresh", host: "gateway.bonez.io", short: "certificate check failed",
      detail: "UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate",
    })
  })

  test("three failed attempts: one line for the person, none on the second session that day", async () => {
    const { home, env } = homeWith("failing")
    await installed(home, env)
    writeFileSync(join(store(home), "sync-state.json"), JSON.stringify({ old: { lastUploadedAt: Date.parse("2026-09-01T10:00:00Z") } }))
    const failed = { ok: false, step: "token refresh", host: "gateway.bonez.io", detail: "x", short: "certificate check failed" }
    writeFileSync(join(store(home), "health.json"), JSON.stringify({ attempts: [failed, failed, failed].map((a, i) => ({ at: i, ...a })) }))
    const first = await start(env)
    assert.match(first.stdout, PERSON)
    assert.match(JSON.parse(first.stdout).systemMessage, /^Bonez session capture has not uploaded since 1 Sep \(certificate check failed\)\. Run /)
    assert.equal((await start(env)).stdout, "")
  })

  test("nothing uploaded for three days and the last attempt failed: one line, then none that day", async () => {
    const { home, env } = homeWith("stale")
    await installed(home, env)
    writeFileSync(join(store(home), "sync-state.json"), JSON.stringify({ old: { lastUploadedAt: Date.now() - 5 * 86_400_000 } }))
    writeFileSync(join(store(home), "health.json"), JSON.stringify({ attempts: [{ at: Date.now() - 4 * 86_400_000, ok: true }, { at: Date.now(), ok: false, short: "server not found" }] }))
    const first = await start(env)
    assert.match(first.stdout, PERSON)
    assert.match(JSON.parse(first.stdout).systemMessage, /has not uploaded since .*, though sessions ran after that \(server not found\)\./)
    assert.equal((await start(env)).stdout, "")
  })

  test("no false warning: an empty session and one still open in another window are not missed uploads", async () => {
    const { home, env } = homeWith("quiet-weekend")
    await installed(home, env)
    const cwd = join(home, "work", "api")
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(store(home), "sync-state.json"), JSON.stringify({ old: { lastUploadedAt: Date.now() - 5 * 86_400_000 } }))
    writeFileSync(join(store(home), "health.json"), JSON.stringify({ attempts: [{ at: Date.now() - 5 * 86_400_000, ok: true }] }))
    const project = join(home, ".claude", "projects", cwd.replace(/[/._]/g, "-"))
    mkdirSync(project, { recursive: true })
    const day = new Date(Date.now() - 86_400_000)
    // Opened and closed with nothing said: the uploader skips it on purpose.
    writeFileSync(join(project, "empty.jsonl"), "")
    utimesSync(join(project, "empty.jsonl"), day, day)
    // Still open in another window: real messages, but its end has not come yet.
    cpSync(join(FIXTURES, "claude-transcript.jsonl"), join(project, "still-open.jsonl"))
    utimesSync(join(project, "still-open.jsonl"), day, day)
    assert.equal((await start(env, cwd)).stdout, "")
    // The catch-up this start ran handled both without a failed attempt, so the next start is quiet too.
    await waitFor(() => existsSync(join(store(home), "sync.log")) && /claude session-start/.test(readFileSync(join(store(home), "sync.log"), "utf8")))
    await waitFor(() => /still-open|claude-transcript/.test(readFileSync(join(store(home), "sync.log"), "utf8")))
    assert.equal((await start(env, cwd)).stdout, "")
    assert.ok((readJsonOr(join(store(home), "health.json")).attempts ?? []).every((a) => a.ok))
  })

  test("the notice takes the uploader's lock, so an attempt recorded meanwhile is kept", async () => {
    const { home, env } = homeWith("lock")
    await installed(home, env)
    const failed = { ok: false, short: "server not found" }
    writeFileSync(join(store(home), "health.json"), JSON.stringify({ attempts: [failed, failed, failed] }))
    const lock = join(store(home), "sync-state.json.lock")
    writeFileSync(lock, "")
    const hookRun = start(env)
    await new Promise((r) => setTimeout(r, 150))
    // The uploader, holding the lock, records one more attempt, then lets go.
    writeFileSync(join(store(home), "health.json"), JSON.stringify({ attempts: [failed, failed, { ...failed, at: 42 }] }))
    rmSync(lock)
    const res = await hookRun
    assert.match(res.stdout, PERSON)
    const health = readJsonOr(join(store(home), "health.json"))
    assert.equal(health.attempts.at(-1).at, 42, "the attempt written under the lock survives")
    assert.ok(health.notified.failing)
  })

  test("the hook writes down its folder only for someone who set capture up", async () => {
    const { home, env } = homeWith("no-capture")
    const hostDir = join(home, ".claude", "plugins", "data", "bonez-bonez")
    mkdirSync(hostDir, { recursive: true })
    // (The stub gateway runs no device flow, so the capture offer has no link and stays silent.)
    assert.equal((await start({ ...env, CLAUDE_PLUGIN_DATA: hostDir })).stdout, "")
    assert.ok(!existsSync(join(home, ".bonez", "session-sync", "hook-folder.json")), "no folder written down for a person without capture")
    writeFileSync(join(hostDir, "config.json"), JSON.stringify({ enabled: false }))
    await start({ ...env, CLAUDE_PLUGIN_DATA: hostDir })
    // It also writes down the server address it uses, with where that came from.
    assert.deepEqual(readJsonOr(join(home, ".bonez", "session-sync", "hook-folder.json")),
      { claude: hostDir, gateway: gateway.url, gatewaySource: "BONEZ_GATEWAY_URL" })
  })

  test("settings in an older folder the hook does not read: one line, then none that day", async () => {
    const { home, env } = homeWith("stranded")
    const hostDir = join(home, ".claude", "plugins", "data", "bonez-acme")
    const older = join(home, ".claude", "plugins", "data", "bonez-bonez")
    mkdirSync(hostDir, { recursive: true })
    mkdirSync(older, { recursive: true })
    writeFileSync(join(older, "config.json"), JSON.stringify({ enabled: true, scope: "global", apiKey: TEST_KEY }))
    const hookEnv = { ...env, CLAUDE_PLUGIN_DATA: hostDir }
    const first = await start(hookEnv)
    assert.match(first.stdout, PERSON)
    assert.match(JSON.parse(first.stdout).systemMessage, /settings are in an older folder this plugin no longer reads/)
    assert.equal((await start(hookEnv)).stdout, "")
  })

  test("a healthy setup, a disabled one, and Cursor or Codex print nothing", async () => {
    const { home, env } = homeWith("healthy")
    await installed(home, env)
    writeFileSync(join(store(home), "sync-state.json"), JSON.stringify({ s: { lastUploadedAt: Date.now() } }))
    writeFileSync(join(store(home), "health.json"), JSON.stringify({ attempts: [{ at: Date.now(), ok: true }] }))
    const res = await start(env)
    assert.equal(res.stdout, "")
    assert.ok(res.ms < 500, `hook wall time was ${res.ms.toFixed(1)}ms`)

    const failed = { ok: false, short: "server not found" }
    writeFileSync(join(store(home), "health.json"), JSON.stringify({ attempts: [failed, failed, failed] }))
    for (const agent of ["cursor", "codex"]) {
      const r = await runCli(["hook", agent, "session-start"], { env, input: JSON.stringify({ hook_event_name: "sessionStart", session_id: "c", conversation_id: "c" }) })
      assert.equal(r.stdout, "", agent)
    }
    assert.equal((await runCli(["disable"], { env })).status, 0)
    assert.equal((await start(env)).stdout, "")
  })
})

// ---------------------------------------------------------------------------- sub-agents and order

describe("catch-up: never a sub-agent transcript, and newest first", () => {
  const line = (sidechain, text) => JSON.stringify({ type: "user", isSidechain: sidechain, cwd: "/tmp/x", message: { role: "user", content: text } })
  const writeAt = (path, body, ageMin) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    const t = new Date(Date.now() - ageMin * 60_000)
    utimesSync(path, t, t)
  }

  test("sub-agent and still-running transcripts are not candidates; the quiet ones come newest first", async () => {
    const mod = await import("../bin/bonez-session-sync.mjs")
    const root = freshDir("catchup-order")
    writeAt(join(root, "old.jsonl"), `${line(false, "old work")}\n`, 600)
    writeAt(join(root, "new.jsonl"), `${line(false, "new work")}\n`, 15)
    // Written a minute ago: probably still running, so not a candidate yet.
    writeAt(join(root, "live.jsonl"), `${line(false, "still running")}\n`, 1)
    writeAt(join(root, "middle.jsonl"), `${JSON.stringify({ type: "summary", summary: "s" })}\n${line(false, "middle")}\n`, 60)
    // Where Claude Code files a sub-agent's transcript, and what it marks on its lines.
    writeAt(join(root, "new", "subagents", "agent-a1.jsonl"), `${line(true, "brief from the lead agent")}\n`, 20)
    // The marker alone is enough, wherever the file is.
    writeAt(join(root, "agent-b2.jsonl"), `${line(true, "brief from the lead agent")}\n`, 25)
    // A message that merely quotes the key is not a sub-agent.
    writeAt(join(root, "quotes.jsonl"), `${line(false, 'it said "isSidechain":true')}\n`, 30)

    const ids = mod.staleTranscriptTargets(root, { excludeId: null, state: {}, cap: 0 }).map((t) => t.sessionId)
    assert.deepEqual(ids, ["new", "quotes", "middle", "old"])
    assert.deepEqual(mod.staleTranscriptTargets(root, { excludeId: null, state: {}, cap: 2 }).map((t) => t.sessionId), ["new", "quotes"])
  })

  test("the live path never uploads a sub-agent transcript either", async () => {
    const dataDir = freshDir("live-subagent")
    await install(dataDir, ["--global"])
    const sub = join(freshDir("subagent-tx"), "lead", "subagents", "agent-c3.jsonl")
    writeAt(sub, `${line(true, "brief")}\n`, 1)
    const payloadFile = join(dataDir, "payload.json")
    writeFileSync(payloadFile, JSON.stringify({ session_id: "agent-c3", transcript_path: sub, cwd: "/tmp/x" }))
    const before = gateway.calls.presign.length
    await runCli(["_upload", "claude", "session-end", payloadFile], { env: { CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url } })
    assert.equal(gateway.calls.presign.length, before)
    assert.match(readFileSync(join(dataDir, "sync.log"), "utf8"), /skipped — a sub-agent transcript/)
  })
})

// ---------------------------------------------------------------------------- one refresh per catch-up

describe("an expired sign-in is refreshed once, and the new token is used from then on", () => {
  const setup = async (prefix, workspaces) => {
    const home = freshDir(prefix)
    const dataDir = join(home, "data")
    mkdirSync(dataDir, { recursive: true })
    // An expired OAuth sign-in, as `login` stores it.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ enabled: true, scope: "global", repos: [],
      oauth: { accessToken: "at-old", refreshToken: "rt-1", expiresAt: Date.now() - 1 } }))
    const cwds = []
    for (const [w, count] of workspaces) {
      const cwd = join(home, "work", w)
      mkdirSync(cwd, { recursive: true })
      const project = join(home, ".claude", "projects", cwd.replace(/[/._]/g, "-"))
      mkdirSync(project, { recursive: true })
      for (let i = 0; i < count; i++) cpSync(join(FIXTURES, "claude-transcript.jsonl"), join(project, `${w}-stale-${i}.jsonl`))
      cwds.push(cwd)
    }
    return { home, dataDir, cwds }
  }
  const startIn = (home, dataDir, cwd, id) => runCli(["hook", "claude", "session-start"], {
    env: { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: dataDir, BONEZ_GATEWAY_URL: gateway.url, BONEZ_OAUTH_CLIENT_ID: "test-client" },
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd }),
  })
  const presignsSince = (n) => gateway.calls.presign.slice(n)

  test("a catch-up of three stale transcripts refreshes once; all three uploads carry the new token", async () => {
    const as = await startStubOAuth({ rotateRefreshToken: "rt-2" })
    gateway.answers.authServer = as.url
    const before = gateway.calls.presign.length
    try {
      const { home, dataDir, cwds } = await setup("refresh-once", [["api", 3]])
      await startIn(home, dataDir, cwds[0], "now")
      await waitFor(() => presignsSince(before).length >= 3 && existsSync(join(dataDir, "sync.log")) &&
        (readFileSync(join(dataDir, "sync.log"), "utf8").match(/upload: session=.* OK$/gm) ?? []).length >= 3, { timeoutMs: 8000 })
      const refreshes = as.calls.token.filter((t) => t.grant_type === "refresh_token")
      assert.deepEqual(refreshes.map((t) => t.refresh_token), ["rt-1"], "one refresh, and no refresh token presented twice")
      assert.deepEqual(presignsSince(before).map((c) => c.headers.authorization), Array(3).fill("Bearer at-refreshed-1"))
      const stored = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).oauth
      assert.equal(stored.accessToken, "at-refreshed-1")
      assert.equal(stored.refreshToken, "rt-2")
    } finally {
      gateway.answers.authServer = null
      await as.close()
    }
  })

  test("two sessions starting together still refresh once", async () => {
    const as = await startStubOAuth({ rotateRefreshToken: "rt-2" })
    gateway.answers.authServer = as.url
    const before = gateway.calls.presign.length
    try {
      const { home, dataDir, cwds } = await setup("refresh-together", [["one", 1], ["two", 1]])
      await Promise.all([startIn(home, dataDir, cwds[0], "a"), startIn(home, dataDir, cwds[1], "b")])
      await waitFor(() => (existsSync(join(dataDir, "sync.log")) &&
        (readFileSync(join(dataDir, "sync.log"), "utf8").match(/upload: session=.* OK$/gm) ?? []).length >= 2), { timeoutMs: 8000 })
      assert.equal(as.calls.token.filter((t) => t.grant_type === "refresh_token").length, 1)
      assert.deepEqual(presignsSince(before).map((c) => c.headers.authorization), Array(2).fill("Bearer at-refreshed-1"))
    } finally {
      gateway.answers.authServer = null
      await as.close()
    }
  })
})

// ---------------------------------------------------------------------------- sign-in for another gateway

describe("a sign-in issued by one gateway is never sent to another", () => {
  test("nothing is sent; the log, the notice and status name both hosts", async () => {
    const home = freshDir("mismatch")
    const dataDir = join(home, "data")
    mkdirSync(dataDir, { recursive: true })
    // Shaped like the gateway's access token: its MCP audience names the gateway that issued it.
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url")
    const token = [b64({ alg: "RS256" }), b64({ aud: ["https://gateway.bonez.io/mcp", "https://example.auth0.com/userinfo"] }), "SIGNATUREPART"].join(".")
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ enabled: true, scope: "global", repos: [],
      oauth: { accessToken: token, refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 } }))
    const cwd = join(home, "work", "api")
    mkdirSync(cwd, { recursive: true })
    const project = join(home, ".claude", "projects", cwd.replace(/[/._]/g, "-"))
    mkdirSync(project, { recursive: true })
    cpSync(join(FIXTURES, "claude-transcript.jsonl"), join(project, "stale.jsonl"))
    // The plugin's server address option points elsewhere (the stub gateway on loopback).
    const env = { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PLUGIN_OPTION_BONEZ_URL: gateway.url }
    const target = new URL(gateway.url).host
    const before = { presign: gateway.calls.presign.length, start: gateway.calls.start.length }
    const res = await runCli(["hook", "claude", "session-start"], { env, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "mm-1", cwd }) })
    const notice = JSON.parse(res.stdout).systemMessage
    assert.ok(notice.startsWith(`Bonez session capture is signed in to gateway.bonez.io, but the plugin's server address is ${target}, so nothing uploads. Sign in again (`), notice)
    assert.doesNotMatch(notice, /rt-1|SIGNATUREPART|eyJ/)
    const log = () => (existsSync(join(dataDir, "sync.log")) ? readFileSync(join(dataDir, "sync.log"), "utf8") : "")
    await waitFor(() => /upload: session=stale agent=claude not sent/.test(log()))
    assert.match(log(), new RegExp(`not sent — signed in to gateway\\.bonez\\.io, but the server address is ${target.replace(".", "\\.")} \\(from the plugin's server address option\\)`))
    assert.match(log(), /start session=mm-1 agent=claude not announced — signed in to gateway\.bonez\.io/)
    assert.doesNotMatch(log(), /rt-1|eyJ/)
    assert.equal(gateway.calls.presign.length, before.presign)
    assert.equal(gateway.calls.start.length, before.start)
    // A hand-run status, without the option in its environment, still says what the hook uses.
    const st = await runCli(["status"], { env: { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: dataDir } })
    assert.match(st.stdout, /gateway: {2}https:\/\/gateway\.bonez\.io \(from the default\)/)
    assert.match(st.stdout, new RegExp(`the Claude Code hook uses: ${gateway.url.replaceAll(".", "\\.")} \\(from the plugin's server address option\\)`))
    assert.match(st.stdout, new RegExp(`sign-in: {2}issued by gateway\\.bonez\\.io, not ${target.replace(".", "\\.")}`))
  })
})

describe("capture offer: one click turns capture on (1SI-4098)", () => {
  // The offer is what later starts show, once the setup page was opened (see the connect tests).
  const offerEnv = (as, extra = {}) => {
    const home = freshDir("offer")
    mkdirSync(join(home, ".bonez", "session-sync"), { recursive: true })
    writeFileSync(join(home, ".bonez", "session-sync", "optin.json"), JSON.stringify({ connectOpenedAt: 1 }))
    return {
      home,
      env: {
        HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: "", BONEZ_SESSION_SYNC_DATA: "",
        BONEZ_GATEWAY_URL: as.url, BONEZ_OAUTH_CLIENT_ID: "test-client", BONEZ_DEVICE_POLL_FLOOR_MS: "50",
        BONEZ_CAPTURE_OFFER: "", ...extra,
      },
    }
  }
  const store = (home) => join(home, ".bonez", "session-sync")
  const optin = (home) => (existsSync(join(store(home), "optin.json")) ? JSON.parse(readFileSync(join(store(home), "optin.json"), "utf8")) : {})
  const start = (agent, env) =>
    runCli(["hook", agent, "session-start"], { env, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "offer-1", cwd: "/tmp/offer", source: "startup" }) })

  test("never set up: one line with the approval link, then capture is on once approved, said once", async () => {
    // Approval after 40 polls of 50ms: late enough that the second start below is still "pending".
    const as = await startStubOAuth({ pendingPolls: 40 })
    try {
      const { home, env } = offerEnv(as)
      const first = await start("claude", env)
      assert.ok(first.ms < 4500, `hook took ${first.ms}ms`)
      const msg = JSON.parse(first.stdout).systemMessage
      assert.match(msg, /^Bonez can save your coding sessions to your team's Bonez/)
      assert.ok(msg.includes(`${as.url}/activate?user_code=WXYZ-1234`), msg)
      assert.match(msg, /Never: \/bonez:capture off$/)
      assert.equal(as.calls.device[0].scope, "bonez:sessions offline_access")
      // The same day: nothing more.
      assert.equal((await start("claude", env)).stdout, "")
      // The person approves (the stub approves after two polls); the worker saves a global config.
      await waitFor(() => existsSync(join(store(home), "config.json")), { timeoutMs: 8000 })
      const cfg = JSON.parse(readFileSync(join(store(home), "config.json"), "utf8"))
      assert.equal(cfg.enabled, true)
      assert.equal(cfg.scope, "global")
      assert.equal(cfg.via, "offer")
      assert.equal(cfg.oauth.refreshToken, "rt-1")
      assert.equal(cfg.apiKey, undefined)
      assert.equal((statSync(join(store(home), "config.json")).mode & 0o777).toString(8), "600")
      const on = await start("claude", env)
      assert.match(JSON.parse(on.stdout).systemMessage, /^Bonez session capture is on: .* \/bonez:capture backfill$/)
      assert.equal((await start("claude", env)).stdout, "")
      assert.equal(as.calls.device.length, 1)
    } finally {
      await as.close()
    }
  })

  test("a link still pending is shown again on a later day, not a new one", async () => {
    const as = await startStubOAuth({ pendingPolls: 10_000 })
    try {
      const { home, env } = offerEnv(as)
      await start("claude", env)
      const state = optin(home)
      writeFileSync(join(store(home), "optin.json"), JSON.stringify({ ...state, lastShownAt: Date.now() - 21 * 3_600_000 }))
      const again = await start("claude", env)
      assert.ok(JSON.parse(again.stdout).systemMessage.includes("/activate?user_code=WXYZ-1234"))
      assert.equal(as.calls.device.length, 1)
      assert.equal(optin(home).shown, 2)
    } finally {
      await as.close()
    }
  })

  test("after three offers it waits a week", async () => {
    const as = await startStubOAuth({ pendingPolls: 10_000 })
    try {
      const { home, env } = offerEnv(as)
      mkdirSync(store(home), { recursive: true })
      writeFileSync(join(store(home), "optin.json"), JSON.stringify({ connectOpenedAt: 1, shown: 3, lastShownAt: Date.now() - 2 * 86_400_000 }))
      assert.equal((await start("claude", env)).stdout, "")
      writeFileSync(join(store(home), "optin.json"), JSON.stringify({ connectOpenedAt: 1, shown: 3, lastShownAt: Date.now() - 8 * 86_400_000 }))
      assert.match(JSON.parse((await start("claude", env)).stdout).systemMessage, /Turn it on with one click/)
    } finally {
      await as.close()
    }
  })

  test("decline: off, and never asked again; `on` withdraws the no and prints the link", async () => {
    const as = await startStubOAuth({ pendingPolls: 10_000 })
    try {
      const { home, env } = offerEnv(as)
      const no = await runCli(["decline"], { env })
      assert.match(no.stdout, /will not ask again/)
      writeFileSync(join(store(home), "optin.json"), JSON.stringify({ ...optin(home), lastShownAt: 0 }))
      assert.equal((await start("claude", env)).stdout, "")
      assert.equal(as.calls.device.length, 0)
      const on = await runCli(["on"], { env })
      assert.equal(on.status, 0, on.stderr)
      assert.ok(on.stdout.includes(`${as.url}/activate?user_code=WXYZ-1234`), on.stdout)
      assert.equal(optin(home).declinedAt, undefined)
    } finally {
      await as.close()
    }
  })

  test("Codex gets a systemMessage, Cursor asks its agent to relay the line", async () => {
    const as = await startStubOAuth({ pendingPolls: 10_000 })
    try {
      const codex = JSON.parse((await start("codex", offerEnv(as).env)).stdout)
      assert.match(codex.systemMessage, /Turn it on with one click: .*Never: node ".*bonez-session-sync\.mjs" decline$/)
      const cursor = JSON.parse((await start("cursor", offerEnv(as).env)).stdout)
      assert.match(cursor.additional_context, /^Tell the user this once, .*"Bonez can save your coding sessions.*\/bonez-capture off"$/)
    } finally {
      await as.close()
    }
  })

  test("no offer with BONEZ_CAPTURE_OFFER=0, for a gateway capture does not serve, or once set up by hand", async () => {
    const as = await startStubOAuth({ pendingPolls: 10_000 })
    try {
      assert.equal((await start("claude", offerEnv(as, { BONEZ_CAPTURE_OFFER: "0" }).env)).stdout, "")
      assert.equal((await start("claude", offerEnv(as, { BONEZ_GATEWAY_URL: "https://bonez.example.com" }).env)).stdout, "")
      const { home, env } = offerEnv(as)
      mkdirSync(store(home), { recursive: true })
      writeFileSync(join(store(home), "config.json"), JSON.stringify({ enabled: false, scope: "global", repos: [], apiKey: TEST_KEY }))
      assert.equal((await start("claude", env)).stdout, "")
      assert.equal(as.calls.device.length, 0)
    } finally {
      await as.close()
    }
  })
})

describe("backfill covers Claude Code, Codex and Cursor (1SI-4098)", () => {
  test("dry run lists each harness's sessions newest first, by the id their own hooks upload under", async () => {
    const home = freshDir("backfill-all")
    const dataDir = join(home, ".bonez", "session-sync")
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ enabled: true, scope: "global", repos: [], apiKey: TEST_KEY }))
    const put = (path, fixture, ageMs) => {
      mkdirSync(dirname(path), { recursive: true })
      cpSync(join(FIXTURES, fixture), path)
      const t = new Date(Date.now() - ageMs)
      utimesSync(path, t, t)
    }
    const uuid = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
    put(join(home, ".claude", "projects", "-work-api", "claude-old.jsonl"), "claude-transcript.jsonl", 3 * 86_400_000)
    put(join(home, ".codex", "sessions", "2026", "11", "20", `rollout-2026-11-20T10-00-00-${uuid}.jsonl`), "codex-rollout.jsonl", 2 * 86_400_000)
    put(join(home, ".cursor", "projects", "work-api", "agent-transcripts", "cur-1", "cur-1.jsonl"), "cursor-transcript.jsonl", 86_400_000)
    put(join(home, ".cursor", "projects", "work-api", "other", "not-a-chat.jsonl"), "cursor-transcript.jsonl", 3_600_000)
    const env = { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: "", BONEZ_GATEWAY_URL: gateway.url, CODEX_HOME: join(home, ".codex") }
    const dry = await runCli(["backfill", "--dry-run"], { env })
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /Sessions not yet uploaded at their current content: 3/)
    const order = [...dry.stdout.matchAll(/^ {2}\d{4}-\d\d-\d\d \d\d:\d\d {2}(\S+(?: \S+)?) +(\S+)$/gm)].map((m) => [m[1].trim(), m[2]])
    assert.deepEqual(order, [["Cursor", "cur-1"], ["Codex", uuid], ["Claude Code", "claude-old"]])
    assert.doesNotMatch(dry.stdout, /not-a-chat/)
    const only = await runCli(["backfill", "--dry-run", "--agent=codex"], { env })
    assert.match(only.stdout, /Sessions not yet uploaded at their current content: 1\n {2}Codex: 1/)
    const bad = await runCli(["backfill", "--agent=vim"], { env })
    assert.equal(bad.status, 1)
    const recent = await runCli(["backfill", "--dry-run", "--since-days=2"], { env })
    assert.match(recent.stdout, /Sessions not yet uploaded at their current content: 1\n {2}Cursor: 1/)
    assert.equal((await runCli(["backfill", "--since-days=0"], { env })).status, 1)
  })
})

describe("connect: the setup page in the browser and this machine share a pairing (1SI-4098)", () => {
  let gw
  before(async () => {
    gw = await startStubGateway()
  })
  after(async () => {
    await gw.close()
  })
  // A fresh pairing script and call record per test.
  const reset = (pairing) => {
    for (const k of Object.keys(gw.calls)) gw.calls[k].length = 0
    gw.answers.pairing = { create: 201, steps: ["waiting"], sessions: null, code: "K7QM-4XPA", secret: "s3cret-poll-token", ...pairing }
  }
  const connectEnv = (extra = {}) => {
    const home = freshDir("connect")
    return {
      home,
      env: {
        HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: "", BONEZ_SESSION_SYNC_DATA: "", CODEX_HOME: join(home, ".codex"),
        BONEZ_GATEWAY_URL: gw.url, BONEZ_CONNECT_NO_OPEN: "1", BONEZ_CONNECT_POLL_MS: "50",
        BONEZ_CONNECT_TOOLS: "claude-code,codex,vim", BONEZ_SESSION_SYNC_DEBOUNCE_MS: "0", ...extra,
      },
    }
  }
  const store = (home) => join(home, ".bonez", "session-sync")
  const readStore = (home, f) => (existsSync(join(store(home), f)) ? JSON.parse(readFileSync(join(store(home), f), "utf8")) : undefined)
  const put = (path, fixture, ageMs) => {
    mkdirSync(dirname(path), { recursive: true })
    cpSync(join(FIXTURES, fixture), path)
    const t = new Date(Date.now() - ageMs)
    utimesSync(path, t, t)
  }
  const history = (home) => {
    put(join(home, ".claude", "projects", "-work-api", "claude-recent.jsonl"), "claude-transcript.jsonl", 2 * 86_400_000)
    put(join(home, ".codex", "sessions", "2026", "11", "20", "rollout-2026-11-20T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl"), "codex-rollout.jsonl", 3 * 86_400_000)
    put(join(home, ".cursor", "projects", "work-api", "agent-transcripts", "cur-old", "cur-old.jsonl"), "cursor-transcript.jsonl", 20 * 86_400_000)
  }
  const pairUrl = () => `${gw.url}/connect?pair=K7QM-4XPA`

  test("answer on + backfill: the key is saved and the last 14 days are uploaded", async () => {
    reset({ steps: ["waiting", "claimed", "answered"], sessions: { on: true, backfill: true, key: "bnz_connect_key_1" } })
    const { home, env } = connectEnv()
    history(home)
    const res = await runCli(["connect", "--opener", "claude-code"], { env })
    assert.equal(res.status, 0, res.stderr)
    const created = gw.calls.pairings[0].body
    assert.equal(created.opener, "claude-code")
    assert.deepEqual(created.tools, [{ id: "claude-code", installed: true }, { id: "codex", installed: true }])
    assert.equal(created.recent_sessions, 2)
    assert.equal(typeof created.host, "string")
    assert.equal(created.plugin_version, JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version)
    assert.deepEqual(gw.calls.pairingResult[0], { code: "K7QM-4XPA", secret: "s3cret-poll-token" })
    assert.equal(gw.calls.pairingResult.length, 3)
    assert.deepEqual(res.stdout.trim().split("\n"), [
      `Open this page in your browser to finish setting up Bonez: ${pairUrl()}`,
      "Waiting for you in the browser…",
      "You're signed in. Finish the steps in your browser…",
      "Session saving is on.",
      "Adding 2 recent sessions… 2/2",
      "All set. You can close the setup page.",
    ])
    const cfg = readStore(home, "config.json")
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.scope, "global")
    assert.deepEqual(cfg.repos, [])
    assert.equal(cfg.apiKey, "bnz_connect_key_1")
    assert.equal(cfg.via, "connect")
    // The key is only good on the gateway it was paired with, so the config names it: a Codex or Cursor hook
    // has no plugin option saying which server, and must not send it to the default.
    assert.equal(cfg.gateway, gw.url)
    const st = await runCli(["status"], { env: { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: "" } })
    assert.match(st.stdout, new RegExp(`gateway: {2}${gw.url.replaceAll(".", "\\.")}`))
    assert.ok(cfg.installedAt)
    assert.equal((statSync(join(store(home), "config.json")).mode & 0o777).toString(8), "600")
    assert.equal(gw.calls.presign.length, 2)
    assert.ok(gw.calls.presign.every((c) => c.headers.authorization === "Bearer bnz_connect_key_1"))
    assert.deepEqual(gw.calls.presign.map((c) => c.body.agent).sort(), ["claude-code", "codex"])
    const optin = readStore(home, "optin.json")
    assert.ok(optin.connectOpenedAt && optin.enabledAt && optin.announcedAt)
  })

  test("answer off: nothing saved, nothing sent", async () => {
    reset({ steps: ["claimed", "answered"], sessions: { on: false, backfill: false, key: null } })
    const { home, env } = connectEnv()
    history(home)
    const res = await runCli(["connect", "--no-open"], { env })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(gw.calls.pairings[0].body.opener, "installer")
    assert.match(res.stdout, /Session saving stays off\./)
    assert.equal(readStore(home, "config.json"), undefined)
    assert.equal(gw.calls.presign.length, 0)
  })

  test("on without backfill saves the key and sends nothing", async () => {
    reset({ steps: ["answered"], sessions: { on: true, backfill: false, key: "bnz_connect_key_2" } })
    const { home, env } = connectEnv()
    history(home)
    const res = await runCli(["connect"], { env })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(readStore(home, "config.json").apiKey, "bnz_connect_key_2")
    assert.equal(gw.calls.presign.length, 0)
    assert.doesNotMatch(res.stdout, /Adding/)
  })

  test("an expired link, an unknown pairing, a server without the route, or a foreign gateway: one line, non-zero", async () => {
    reset({ steps: ["waiting", "expired"] })
    let { home, env } = connectEnv()
    let res = await runCli(["connect"], { env })
    assert.equal(res.status, 1)
    assert.equal(res.stderr.trim(), "The setup link expired. Run this again to get a new one.")
    assert.equal(readStore(home, "config.json"), undefined)

    // The stub hands out one secret and checks another: the poll is a 404.
    reset({ issuedSecret: "not-the-one-it-checks" })
    ;({ env } = connectEnv())
    res = await runCli(["connect"], { env })
    assert.equal(res.status, 1)
    assert.equal(res.stderr.trim(), "The setup link is no longer valid. Run this again to get a new one.")

    reset({ create: 404 })
    ;({ env } = connectEnv())
    res = await runCli(["connect"], { env })
    assert.equal(res.status, 1)
    assert.equal(res.stderr.trim(), "Could not start the Bonez setup: this Bonez server does not offer the setup page yet.")

    reset()
    ;({ env } = connectEnv({ BONEZ_GATEWAY_URL: "https://bonez.example.com" }))
    res = await runCli(["connect"], { env })
    assert.equal(res.status, 1)
    assert.match(res.stderr, /refusing `connect`/)
    assert.equal(gw.calls.pairings.length, 0)
  })

  test("--detach returns at once; the child finishes in the background and writes only to sync.log", async () => {
    reset({ steps: ["waiting", "answered"], sessions: { on: true, backfill: false, key: "bnz_connect_key_3" } })
    const { home, env } = connectEnv()
    const res = await runCli(["connect", "--detach", "--opener", "codex"], { env })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(res.stdout, "")
    assert.ok(res.ms < 2000, `connect --detach took ${res.ms}ms`)
    await waitFor(() => readStore(home, "config.json"), { timeoutMs: 8000 })
    assert.equal(readStore(home, "config.json").apiKey, "bnz_connect_key_3")
    assert.equal(gw.calls.pairings[0].body.opener, "codex")
    await waitFor(() => readFileSync(join(store(home), "sync.log"), "utf8").includes("connect: All set."), { timeoutMs: 4000 })
    const log = readFileSync(join(store(home), "sync.log"), "utf8")
    assert.ok(log.includes(`connect: Open this page in your browser to finish setting up Bonez: ${pairUrl()}`), log)
    assert.ok(log.includes("connect: Session saving is on."), log)
    assert.ok(!log.includes("bnz_connect_key_3"), "the key is never logged")
  })

  test("BONEZ_PAIR (the Settings page's command): joins that pairing, opens nothing, then saves the key", async () => {
    reset({ steps: ["claimed", "answered"], sessions: { on: true, backfill: true, key: "bnz_connect_key_4" } })
    const { home, env } = connectEnv({ BONEZ_CONNECT_NO_OPEN: "", BONEZ_PAIR: "K7QM-4XPA.s3cret-poll-token" })
    history(home)
    const res = await runCli(["connect", "--opener", "installer"], { env })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(gw.calls.pairings.length, 0, "no pairing of its own")
    const joined = gw.calls.pairingJoin[0].body
    assert.equal(joined.pair, "K7QM-4XPA.s3cret-poll-token")
    assert.equal(joined.opener, "installer")
    assert.deepEqual(joined.tools, [{ id: "claude-code", installed: true }, { id: "codex", installed: true }])
    assert.equal(joined.recent_sessions, 2)
    assert.deepEqual(gw.calls.pairingResult[0], { code: "K7QM-4XPA", secret: "s3cret-poll-token" })
    assert.deepEqual(res.stdout.trim().split("\n"), [
      "Continue on the Bonez page in your browser.",
      "Session saving is on.",
      "Adding 2 recent sessions… 2/2",
      "All set. You can close the setup page.",
    ])
    assert.doesNotMatch(res.stdout, /http/, "no link to open: the page is open already")
    assert.equal(readStore(home, "config.json").apiKey, "bnz_connect_key_4")
    assert.ok(readStore(home, "optin.json").connectOpenedAt)
  })

  test("--pair works like BONEZ_PAIR; a wrong, expired or malformed pair is one line, non-zero", async () => {
    reset({ steps: ["answered"], sessions: { on: false, backfill: false, key: null } })
    let { env } = connectEnv()
    let res = await runCli(["connect", "--pair", "k7qm4xpa.s3cret-poll-token"], { env })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(gw.calls.pairingJoin[0].body.pair, "K7QM-4XPA.s3cret-poll-token")
    assert.match(res.stdout, /Session saving stays off/)

    reset()
    ;({ env } = connectEnv({ BONEZ_PAIR: "K7QM-4XPA.not-the-secret-at-all" }))
    res = await runCli(["connect"], { env })
    assert.equal(res.status, 1)
    assert.equal(res.stderr.trim(), "The setup command is no longer valid. Copy a new one from the Bonez page.")

    reset({ join: 410 })
    ;({ env } = connectEnv({ BONEZ_PAIR: "K7QM-4XPA.s3cret-poll-token" }))
    res = await runCli(["connect"], { env })
    assert.equal(res.status, 1)
    assert.equal(res.stderr.trim(), "The setup command expired. Copy a new one from the Bonez page.")

    reset()
    ;({ env } = connectEnv({ BONEZ_PAIR: "nonsense" }))
    res = await runCli(["connect"], { env })
    assert.equal(res.status, 1)
    assert.equal(res.stderr.trim(), "The setup command is incomplete. Copy it again from the Bonez page.")
    assert.equal(gw.calls.pairingJoin.length, 0)
    assert.equal(gw.calls.pairings.length, 0)
  })

  test("a hook's background connect ignores a BONEZ_PAIR left in the environment", async () => {
    reset({ steps: ["waiting", "answered"], sessions: { on: false, backfill: false, key: null } })
    const { home, env } = connectEnv({ BONEZ_PAIR: "K7QM-4XPA.s3cret-poll-token" })
    const res = await runCli(["connect", "--detach", "--opener", "codex"], { env })
    assert.equal(res.status, 0, res.stderr)
    await waitFor(() => existsSync(join(store(home), "sync.log")) && readFileSync(join(store(home), "sync.log"), "utf8").includes("stays off"), { timeoutMs: 8000 })
    assert.equal(gw.calls.pairings.length, 1)
    assert.equal(gw.calls.pairingJoin.length, 0)
  })

  test("session start with nothing set up opens the page once and says so; later starts do not", async () => {
    reset({ steps: ["waiting", "answered"], sessions: { on: false, backfill: false, key: null } })
    const { home, env } = connectEnv({ BONEZ_CAPTURE_OFFER: "", BONEZ_OAUTH_CLIENT_ID: "" })
    const start = (agent) =>
      runCli(["hook", agent, "session-start"], { env, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "c-1", cwd: "/tmp/c" }) })
    const first = await start("claude")
    assert.ok(first.ms < 4500, `hook took ${first.ms}ms`)
    assert.equal(
      JSON.parse(first.stdout).systemMessage,
      `Bonez opened a setup page in your browser to finish connecting. If it did not open: ${pairUrl()}`,
    )
    assert.equal(gw.calls.pairings.length, 1)
    assert.equal(gw.calls.pairings[0].body.opener, "claude-code")
    assert.ok(readStore(home, "optin.json").connectOpenedAt)
    await waitFor(() => gw.calls.pairingResult.length >= 2, { timeoutMs: 4000 })
    assert.equal((await start("claude")).stdout, "")
    assert.equal((await start("cursor")).stdout, "")
    assert.equal(gw.calls.pairings.length, 1)
  })

  test("the hook says nothing when the server has no setup page, or with BONEZ_CAPTURE_OFFER=0", async () => {
    reset({ create: 404 })
    const { home, env } = connectEnv({ BONEZ_CAPTURE_OFFER: "", BONEZ_OAUTH_CLIENT_ID: "" })
    const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "c-2", cwd: "/tmp/c" })
    const res = await runCli(["hook", "codex", "session-start"], { env, input })
    assert.equal(res.stdout, "")
    assert.ok(readStore(home, "optin.json").connectOpenedAt)
    const off = connectEnv({ BONEZ_CAPTURE_OFFER: "0" })
    assert.equal((await runCli(["hook", "claude", "session-start"], { env: off.env, input })).stdout, "")
    assert.equal(readStore(off.home, "optin.json"), undefined)
    assert.equal(gw.calls.pairings.length, 1)
  })
})
