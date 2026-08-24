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
