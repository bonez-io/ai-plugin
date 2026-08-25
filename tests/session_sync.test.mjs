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
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync, cpSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

import { startStubGateway } from "./lib/stub-gateway.mjs"
import { startStubOAuth } from "./lib/stub-oauth.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, "..")
const SCRIPT = join(REPO_ROOT, "bin", "bonez-session-sync.mjs")
const FIXTURES = join(HERE, "fixtures")
const TEST_KEY = "bnz_sessions_test_0123456789abcdef"

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), `bonez-session-sync-${prefix}-`))
}

// MUST be non-blocking (spawn, not spawnSync): the stub gateway in this file's `before()` runs
// an HTTP server IN THIS SAME PROCESS. spawnSync freezes this process's event loop until the
// child exits — including the libuv turns the gateway's http.Server needs to accept and answer
// the child's own requests — which deadlocks any test where the spawned CLI talks HTTP back to
// it (everything under `_upload`). `hook`'s own tests happened to survive spawnSync because the
// process it blocks on returns immediately without ever making an HTTP call itself — the actual
// upload happens in a further-detached grandchild this process was never watching — but async
// spawn here removes the trap for every case uniformly instead of relying on that distinction.
function runCli(args, { env = {}, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
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
  test("round-trips config, masks the key, never echoes it back raw in status", async () => {
    const dataDir = freshDir("cfg")
    const res = await install(dataDir, ["--repo", "/tmp/some-repo"])
    assert.match(res.stdout, /installed and ENABLED/)
    assert.doesNotMatch(res.stdout, new RegExp(TEST_KEY)) // consent text must not print the raw key

    const status = await runCli(["status"], { env: { CLAUDE_PLUGIN_DATA: dataDir } })
    assert.equal(status.status, 0)
    assert.doesNotMatch(status.stdout, new RegExp(TEST_KEY))
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
      assert.match(res.stdout, /cannot read the lake/)

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
    assert.doesNotMatch(raw, /sk_live_ABCDEFGHIJKLMNOPQRSTUVWX/)
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
    assert.doesNotMatch(raw, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/)
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

// ---------------------------------------------------------------------------- real transcript

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
    const secret = "sk_live_ZZZZYYYYXXXXWWWWVVVVUUUU"
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
